// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TreasuryPolicy} from "./TreasuryPolicy.sol";
import {IAttestationVerifier} from "./interfaces/IAttestationVerifier.sol";

/**
 * @title ReportVerifier
 * @notice Décide si un rapport produit par le moteur confidentiel est recevable.
 *
 * @dev Ce contrat ne juge pas du *contenu* du rapport — c'est le rôle du coffre, qui
 *      applique ses propres bornes. Il juge de sa *provenance* et de sa *fraîcheur* :
 *
 *        • le rapport vient bien du quorum de signataires attendu ;
 *        • il a bien été produit par l'enclave attendue, et l'attestation porte sur ce
 *          contenu précis et pas un autre ;
 *        • il se rapporte à la version de politique et au jeu de paramètres en vigueur ;
 *        • il n'a pas expiré, ses entrées de marché ne sont pas périmées ;
 *        • il n'a jamais été consommé.
 *
 *      Les contrôles sont ordonnés du moins cher au plus cher : un rapport périmé est
 *      rejeté avant qu'on ne dépense du gaz à recouvrer des signatures.
 */
contract ReportVerifier {
    /* ---------------------------------------------------------------------- */
    /*                                 Structure                               */
    /* ---------------------------------------------------------------------- */

    struct RebalanceReport {
        uint64 epoch;
        uint64 nonce;
        /// @notice Au-delà, le rapport n'est plus exécutable.
        uint64 expiry;
        /// @notice Horodatage des données de marché ayant servi à décider.
        uint64 inputsTimestamp;
        uint32 policyVersion;
        /// @notice Lie le rapport au jeu de paramètres hors enclave (D5).
        bytes32 bandParamsHash;
        /// @notice Empreinte des entrées publiques : taux, gaz, quotes indicatifs.
        bytes32 inputsHash;
        /// @notice Engagement sur le plan d'ordres, révélé plus tard par le coffre (D6).
        bytes32 ordersCommitment;
        /// @notice Métriques agrégées, en points de base — jamais de montant.
        int32 esBeforeBps;
        int32 esAfterBps;
        uint128 costEstimate;
    }

    /* ---------------------------------------------------------------------- */

    bytes32 private constant REPORT_TYPEHASH = keccak256(
        "RebalanceReport(uint64 epoch,uint64 nonce,uint64 expiry,uint64 inputsTimestamp,"
        "uint32 policyVersion,bytes32 bandParamsHash,bytes32 inputsHash,"
        "bytes32 ordersCommitment,int32 esBeforeBps,int32 esAfterBps,uint128 costEstimate)"
    );

    /// @dev Borne haute de s imposée par l'EIP-2 : sans elle, toute signature admet une
    ///      seconde forme valide, ce qui donnerait deux identifiants pour un même rapport.
    uint256 private constant HALF_ORDER =
        0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    TreasuryPolicy public immutable POLICY;

    IAttestationVerifier public attestationVerifier;
    /// @notice Mesure de l'enclave autorisée à produire des rapports.
    bytes32 public expectedMeasurement;

    /// @notice Signataires du réseau d'oracles habilités.
    mapping(address signer => bool) public isSigner;
    uint8 public signerCount;
    /// @notice Nombre minimal de signatures distinctes.
    uint8 public threshold;

    uint64 public lastEpoch;
    uint64 public lastNonce;
    uint64 public lastVerifiedAt;

    mapping(bytes32 reportId => bool) public consumed;
    mapping(bytes32 reportId => RebalanceReport) private _reports;

    /// @dev Mis en cache mais recalculé en cas de bifurcation de chaîne.
    uint256 private immutable INITIAL_CHAIN_ID;
    bytes32 private immutable INITIAL_DOMAIN_SEPARATOR;

    /* ---------------------------------------------------------------------- */

    event SignerSet(address indexed signer, bool enabled);
    event ThresholdSet(uint8 threshold);
    event AttestationVerifierSet(address indexed verifier, bytes32 measurement);
    event ReportVerified(bytes32 indexed reportId, uint64 indexed epoch, uint64 nonce);

    error NotAdmin(address caller);
    error SystemPaused();
    error ReportExpired(uint64 expiry, uint256 nowTs);
    error InputsStale(uint64 inputsTimestamp, uint32 maxStalenessSec);
    error InputsFromTheFuture(uint64 inputsTimestamp);
    error SequenceNotIncreasing(uint64 epoch, uint64 nonce, uint64 lastEpoch, uint64 lastNonce);
    error EpochTooSoon(uint64 elapsed, uint32 minInterval);
    error PolicyVersionMismatch(uint32 got, uint32 expected);
    error BandParamsMismatch(bytes32 got, bytes32 expected);
    error ReportAlreadyConsumed(bytes32 reportId);
    error NotEnoughSignatures(uint256 got, uint8 required);
    error SignersNotSorted();
    error UnknownSigner(address signer);
    error MalleableSignature();
    error AttestationRejected(bytes32 reportId);
    error ThresholdOutOfRange(uint8 threshold, uint8 signerCount);
    error TimestampOverflow(uint256 value);

    /* ---------------------------------------------------------------------- */

    modifier onlyAdmin() {
        _requireAdmin();
        _;
    }

    function _requireAdmin() private view {
        if (!POLICY.isAdmin(msg.sender)) revert NotAdmin(msg.sender);
    }

    constructor(TreasuryPolicy policy_, IAttestationVerifier verifier_, bytes32 measurement_) {
        POLICY = policy_;
        attestationVerifier = verifier_;
        expectedMeasurement = measurement_;
        threshold = 1;
        INITIAL_CHAIN_ID = block.chainid;
        INITIAL_DOMAIN_SEPARATOR = _buildDomainSeparator();
    }

    /* ---------------------------------------------------------------------- */
    /*                             Administration                              */
    /* ---------------------------------------------------------------------- */

    function setSigner(address signer, bool enabled) external onlyAdmin {
        bool current = isSigner[signer];
        if (current != enabled) {
            isSigner[signer] = enabled;
            signerCount = enabled ? signerCount + 1 : signerCount - 1;
        }
        emit SignerSet(signer, enabled);
    }

    function setThreshold(uint8 t) external onlyAdmin {
        if (t == 0 || t > signerCount) revert ThresholdOutOfRange(t, signerCount);
        threshold = t;
        emit ThresholdSet(t);
    }

    function setAttestationVerifier(IAttestationVerifier v, bytes32 measurement)
        external
        onlyAdmin
    {
        attestationVerifier = v;
        expectedMeasurement = measurement;
        emit AttestationVerifierSet(address(v), measurement);
    }

    /* ---------------------------------------------------------------------- */
    /*                              Identifiants                               */
    /* ---------------------------------------------------------------------- */

    /**
     * @notice Clé d'idempotence d'un rapport.
     * @dev Le rejeu d'un rapport signifierait un rééquilibrage exécuté deux fois, donc
     *      une position doublée. C'est le défaut le plus coûteux imaginable dans ce
     *      domaine, et la seule protection est de consommer un identifiant unique de
     *      façon atomique. L'engagement sur les ordres en fait partie : deux plans
     *      distincts au même epoch restent deux rapports distincts.
     */
    function reportId(RebalanceReport calldata r) public pure returns (bytes32) {
        return keccak256(abi.encode(r.policyVersion, r.epoch, r.nonce, r.ordersCommitment));
    }

    function domainSeparator() public view returns (bytes32) {
        return
            block.chainid == INITIAL_CHAIN_ID ? INITIAL_DOMAIN_SEPARATOR : _buildDomainSeparator();
    }

    function digest(RebalanceReport calldata r) public view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), _structHash(r)));
    }

    function reportOf(bytes32 id) external view returns (RebalanceReport memory) {
        return _reports[id];
    }

    /* ---------------------------------------------------------------------- */
    /*                              Vérification                               */
    /* ---------------------------------------------------------------------- */

    /**
     * @notice Vérifie un rapport et le consomme.
     * @param signatures Signatures ordonnées par adresse de signataire strictement
     *                   croissante. L'ordre n'est pas une commodité : il rend impossible
     *                   de présenter deux fois la même signature pour atteindre le quorum.
     */
    function verify(
        RebalanceReport calldata r,
        bytes calldata attestation,
        bytes[] calldata signatures
    ) external returns (bytes32 id) {
        if (POLICY.paused()) revert SystemPaused();

        // — contrôles de temps, les moins chers —
        //
        // Le linter signale l'usage de block.timestamp, et à juste titre : un validateur
        // dispose d'une marge de quelques secondes, ce qui sur une fenêtre de fraîcheur de
        // soixante secondes n'est pas anecdotique. La fenêtre n'est donc pas la protection
        // principale contre une décision prise sur de mauvais prix — elle en est la
        // première couche. La seconde, et la vraie, est le contrôle de déviation appliqué
        // par le coffre au moment d'exécuter : le prix obtenu du lieu d'exécution est
        // comparé à l'oracle, et l'ordre est refusé au-delà du seuil. Un rapport dont les
        // entrées auraient vieilli de quelques secondes de plus que prévu ne peut donc pas
        // produire une exécution hors marché.
        // forge-lint: disable-next-line(block-timestamp)
        if (r.expiry <= block.timestamp) revert ReportExpired(r.expiry, block.timestamp);
        // forge-lint: disable-next-line(block-timestamp)
        if (r.inputsTimestamp > block.timestamp) revert InputsFromTheFuture(r.inputsTimestamp);

        uint32 maxStaleness = POLICY.maxStalenessSec();
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp - r.inputsTimestamp > maxStaleness) {
            revert InputsStale(r.inputsTimestamp, maxStaleness);
        }

        // — idempotence, avant tout le reste : c'est le contrôle le plus précis et il
        //   coûte un seul accès au stockage. Le placer ici garantit qu'un rejeu échoue
        //   pour la bonne raison, et non parce qu'un contrôle de séquence l'aurait
        //   incidemment attrapé — un message d'erreur exact vaut mieux qu'un rejet
        //   heureux —
        id = reportId(r);
        if (consumed[id]) revert ReportAlreadyConsumed(id);

        // — séquence strictement croissante sur le couple (epoch, nonce) —
        //
        // Le nonce n'est pas décoratif. Le parcours de crise de la spec (§2.3) exige un
        // déclenchement *hors cycle* : un choc de flux vide un corridor entre deux
        // epochs et il faut décider immédiatement. Imposer la stricte croissance du seul
        // epoch interdirait ce rapport supplémentaire. Le couple (epoch, nonce) autorise
        // plusieurs rapports dans un même epoch tout en interdisant tout retour en
        // arrière.
        bool ordered = r.epoch > lastEpoch || (r.epoch == lastEpoch && r.nonce > lastNonce);
        if (!ordered) revert SequenceNotIncreasing(r.epoch, r.nonce, lastEpoch, lastNonce);

        // — cadence : borne le préjudice d'un opérateur compromis et coupe court à un
        //   attaquant qui provoquerait des rééquilibrages coûteux à répétition —
        uint32 minInterval = POLICY.minEpochIntervalSec();
        if (lastVerifiedAt != 0) {
            uint64 elapsed = _toUint64(block.timestamp) - lastVerifiedAt;
            if (elapsed < minInterval) revert EpochTooSoon(elapsed, minInterval);
        }

        // — cohérence avec la politique en vigueur —
        uint32 version = POLICY.policyVersion();
        if (r.policyVersion != version) revert PolicyVersionMismatch(r.policyVersion, version);
        bytes32 expectedBandParams = POLICY.bandParamsHash();
        if (r.bandParamsHash != expectedBandParams) {
            revert BandParamsMismatch(r.bandParamsHash, expectedBandParams);
        }

        // — état écrit avant tout appel externe —
        consumed[id] = true;
        _reports[id] = r;
        lastEpoch = r.epoch;
        lastNonce = r.nonce;
        lastVerifiedAt = _toUint64(block.timestamp);

        // — provenance —
        bytes32 payload = digest(r);
        _requireQuorum(payload, signatures);
        if (!attestationVerifier.verify(attestation, expectedMeasurement, payload)) {
            revert AttestationRejected(id);
        }

        // Le linter voit un événement émis après des appels externes. Tous les appels
        // externes de cette fonction sont déclarés `view`, donc compilés en STATICCALL :
        // un rappel ne pourrait modifier aucun état. Et l'ordre importe ici — l'événement
        // ne doit être émis que si l'attestation a été acceptée.
        // forge-lint: disable-next-line(reentrancy-events)
        emit ReportVerified(id, r.epoch, r.nonce);
    }

    /* ---------------------------------------------------------------------- */

    function _requireQuorum(bytes32 payload, bytes[] calldata signatures) private view {
        uint256 n = signatures.length;
        if (n < threshold) revert NotEnoughSignatures(n, threshold);

        // Le linter déconseille de révoquer à l'intérieur d'une boucle, parce qu'un
        // élément fautif y fait échouer tout un lot. Ici il ne s'agit pas d'un lot
        // d'éléments indépendants mais d'un quorum : une signature invalide, dupliquée ou
        // inconnue invalide l'ensemble par définition. Un succès partiel n'aurait aucun
        // sens — on ne vérifie pas des signatures, on vérifie *une* décision collective.
        address previous = address(0);
        for (uint256 i = 0; i < n; i++) {
            address signer = _recover(payload, signatures[i]);
            // forge-lint: disable-next-line(require-revert-in-loop)
            if (signer <= previous) revert SignersNotSorted();
            // forge-lint: disable-next-line(require-revert-in-loop)
            if (!isSigner[signer]) revert UnknownSigner(signer);
            previous = signer;
        }
    }

    function _recover(bytes32 payload, bytes calldata signature) private pure returns (address) {
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        // Ces deux gardes sont signalées comme « revert dans une boucle » parce que
        // l'appelant est une boucle de quorum : même raisonnement qu'au-dessus.
        // forge-lint: disable-next-line(require-revert-in-loop)
        if (uint256(s) > HALF_ORDER) revert MalleableSignature();
        address signer = ecrecover(payload, v, r, s);
        // forge-lint: disable-next-line(require-revert-in-loop)
        if (signer == address(0)) revert UnknownSigner(signer);
        return signer;
    }

    function _toUint64(uint256 v) private pure returns (uint64) {
        if (v > type(uint64).max) revert TimestampOverflow(v);
        // La ligne précédente est la garde qui rend ce cast sûr.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint64(v);
    }

    function _structHash(RebalanceReport calldata r) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                REPORT_TYPEHASH,
                r.epoch,
                r.nonce,
                r.expiry,
                r.inputsTimestamp,
                r.policyVersion,
                r.bandParamsHash,
                r.inputsHash,
                r.ordersCommitment,
                r.esBeforeBps,
                r.esAfterBps,
                r.costEstimate
            )
        );
    }

    function _buildDomainSeparator() private view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256("FLOAT"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
    }
}

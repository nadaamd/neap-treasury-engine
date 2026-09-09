// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IFxVenue} from "../interfaces/IFxVenue.sol";
import {MockERC20} from "./MockERC20.sol";

/**
 * @title MockFxVenue
 * @notice Lieu d'exécution déterministe : prix pivot paramétrable, spread, et impact en
 *         racine carrée de la taille.
 *
 * @dev Le modèle d'impact reprend celui du moteur hors chaîne :
 *
 *          coût_relatif = spread + eta · √(taille / profondeur)
 *
 *      La racine carrée n'est pas décorative — c'est la forme empirique classique de
 *      l'impact de marché, et sa concavité fait que le coût *marginal* décroît avec la
 *      taille alors que le coût *total* croît plus vite que linéairement. C'est ce qui
 *      rend l'arbitrage entre gros ordres rares et petits ordres fréquents non trivial.
 *
 *      `eta` n'est pas calibré (SPEC §4.6) : la profondeur réelle du carnet d'Arc est
 *      inconnue. Il est donc paramétrable et sa valeur doit être affichée avec tout
 *      résultat chiffré.
 *
 *      Les deux jetons sont supposés à six décimales, comme l'USDC.
 */
contract MockFxVenue is IFxVenue {
    uint256 private constant WAD = 1e18;
    uint256 private constant BPS = 10_000;

    struct Pair {
        /// @dev Unités de tokenOut par unité de tokenIn, en WAD.
        uint256 rateWad;
        uint16 spreadBps;
        /// @dev Coefficient d'impact, en points de base à profondeur pleine.
        uint16 etaBps;
        uint256 depth;
        bool enabled;
    }

    mapping(bytes32 pairKey => Pair) public pairs;
    uint64 public quoteTtl = 60;

    event PairConfigured(address indexed tokenIn, address indexed tokenOut, uint256 rateWad);
    event Settled(
        address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut
    );

    error PairDisabled(address tokenIn, address tokenOut);
    error QuoteMismatch(bytes32 expected, bytes32 provided);
    error SlippageExceeded(uint256 amountOut, uint256 minAmountOut);
    error CostExceedsNotional();
    error TransferFailed(address token);
    error TimestampOverflow(uint256 value);

    function key(address tokenIn, address tokenOut) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(tokenIn, tokenOut));
    }

    function configure(
        address tokenIn,
        address tokenOut,
        uint256 rateWad,
        uint16 spreadBps,
        uint16 etaBps,
        uint256 depth
    ) external {
        pairs[key(tokenIn, tokenOut)] = Pair({
            rateWad: rateWad, spreadBps: spreadBps, etaBps: etaBps, depth: depth, enabled: true
        });
        emit PairConfigured(tokenIn, tokenOut, rateWad);
    }

    function setQuoteTtl(uint64 ttl) external {
        quoteTtl = ttl;
    }

    /// @inheritdoc IFxVenue
    function quote(address tokenIn, address tokenOut, uint256 amountIn)
        public
        view
        returns (uint256 amountOut, uint64 quoteExpiry, bytes32 quoteId)
    {
        Pair storage p = pairs[key(tokenIn, tokenOut)];
        if (!p.enabled) revert PairDisabled(tokenIn, tokenOut);

        uint256 costBps = uint256(p.spreadBps) + _impactBps(amountIn, p.depth, p.etaBps);
        if (costBps >= BPS) revert CostExceedsNotional();

        // Toutes les multiplications avant les divisions : diviser d'abord perdrait de la
        // précision sur les petits montants, et un moteur de trésorerie place des ordres
        // dont la taille varie de plusieurs ordres de grandeur.
        amountOut = amountIn * p.rateWad * (BPS - costBps) / (WAD * BPS);
        quoteExpiry = _toUint64(block.timestamp) + quoteTtl;
        quoteId = keccak256(abi.encode(tokenIn, tokenOut, amountIn, amountOut, quoteExpiry));
    }

    /// @inheritdoc IFxVenue
    function settlePvP(bytes32 quoteId, uint256 amountIn, uint256 minAmountOut, address to)
        external
        returns (uint256 amountOut)
    {
        (address tokenIn, address tokenOut) = _decodeSides(quoteId);
        uint256 expiry;
        bytes32 expected;
        (amountOut, expiry, expected) = quote(tokenIn, tokenOut, amountIn);

        // Le prix exécuté doit être celui qui a été annoncé. Sans ce contrôle, un carnet
        // qui s'est vidé entre l'annonce et l'exécution servirait au pire prix disponible.
        if (expected != quoteId) revert QuoteMismatch(expected, quoteId);
        if (amountOut < minAmountOut) revert SlippageExceeded(amountOut, minAmountOut);

        // L'événement précède les appels externes : un appel réentrant pourrait sinon
        // réordonner ou fabriquer des journaux sur lesquels s'appuient les consommateurs
        // hors chaîne. Si un transfert échoue, la transaction entière est annulée et
        // l'événement disparaît avec elle.
        emit Settled(tokenIn, tokenOut, amountIn, amountOut);

        // Débit et crédit dans le même appel : c'est l'hypothèse d'atomicité de l'interface.
        if (!MockERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn)) {
            revert TransferFailed(tokenIn);
        }
        if (!MockERC20(tokenOut).transfer(to, amountOut)) revert TransferFailed(tokenOut);
    }

    /* ---------------------------------------------------------------- */

    /// @dev Le `quoteId` ne porte pas les adresses de jetons en clair ; le mock les
    ///      retrouve via l'enregistrement posé par `prepare`. Un lieu réel signerait un
    ///      quote structuré et n'aurait pas besoin de ce détour.
    mapping(bytes32 quoteId => address[2] sides) private _sides;

    /// @notice Enregistre un quote afin qu'il puisse être réglé ensuite.
    function prepare(address tokenIn, address tokenOut, uint256 amountIn)
        external
        returns (uint256 amountOut, uint64 quoteExpiry, bytes32 quoteId)
    {
        (amountOut, quoteExpiry, quoteId) = quote(tokenIn, tokenOut, amountIn);
        _sides[quoteId] = [tokenIn, tokenOut];
    }

    function _decodeSides(bytes32 quoteId) private view returns (address, address) {
        address[2] storage s = _sides[quoteId];
        return (s[0], s[1]);
    }

    /// @dev eta · √(taille / profondeur), en points de base.
    function _impactBps(uint256 amountIn, uint256 depth, uint16 etaBps)
        private
        pure
        returns (uint256)
    {
        if (depth == 0 || etaBps == 0) return 0;
        return uint256(etaBps) * _sqrt(amountIn * WAD * WAD / depth) / WAD;
    }

    function _toUint64(uint256 v) private pure returns (uint64) {
        if (v > type(uint64).max) revert TimestampOverflow(v);
        // Le linter signale tout cast rétrécissant. Ici la ligne précédente *est* la garde
        // qui le rend sûr — c'est la raison d'être de cette fonction.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint64(v);
    }

    /// @dev Racine carrée entière par la méthode babylonienne.
    function _sqrt(uint256 x) private pure returns (uint256 y) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }
}

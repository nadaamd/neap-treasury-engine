// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title IFxVenue
 * @notice Lieu d'exécution d'une jambe de change.
 *
 * @dev Décision D8. Le moteur ne dépend jamais d'un lieu particulier : il parle à cette
 *      interface, implémentée par `MockFxVenue` — déterministe, utilisé par le backtest.
 *
 *      Ce n'est pas un repli : le backtest **exige** un lieu d'exécution rejouable, et le
 *      fait que backtest et exécution partagent la même interface est ce qui rend le
 *      backtest opposable — la politique testée est littéralement la politique exécutée.
 *
 *      **Ce que cette interface ne décrit pas : StableFX** (décision D21). Le moteur FX
 *      d'Arc ne s'appelle pas depuis un contrat. Son flux est en trois temps — demande de
 *      cotation à plusieurs teneurs, acceptation hors chaîne pour la vitesse, puis
 *      règlement par escrow avec Permit2 et confirmation d'intention en données typées.
 *      L'adaptateur correspondant vit donc hors chaîne, pas ici. On l'a vérifié dans la
 *      documentation plutôt que supposé : `docs/JALON-0.md`.
 */
interface IFxVenue {
    /**
     * @notice Prix indicatif pour une taille donnée.
     * @dev Le `quoteId` lie l'exécution au prix annoncé. Un lieu réel signerait ce
     *      quote hors chaîne ; le mock le dérive de ses paramètres courants, ce qui
     *      suffit à détecter une exécution à un prix qui n'est plus celui annoncé.
     */
    function quote(address tokenIn, address tokenOut, uint256 amountIn)
        external
        view
        returns (uint256 amountOut, uint64 quoteExpiry, bytes32 quoteId);

    /**
     * @notice Règlement livraison contre paiement.
     * @dev L'appelant doit avoir approuvé `amountIn` de `tokenIn`.
     *
     *      **Atomicité.** Du point de vue de l'appelant, le débit de `tokenIn` et le
     *      crédit de `tokenOut` réussissent ou échouent ensemble — ce qui élimine le
     *      risque de règlement Herstatt. C'était une hypothèse à vérifier ; la
     *      documentation de StableFX la confirme pour son escrow PvP (« both sides
     *      complete or neither does »). La machine à états du coffre n'a donc pas besoin
     *      d'état de compensation (D20).
     */
    function settlePvP(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address to,
        bytes32 quoteId
    ) external returns (uint256 amountOut);
}

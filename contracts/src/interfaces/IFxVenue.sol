// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title IFxVenue
 * @notice Lieu d'exécution d'une jambe de change.
 *
 * @dev Décision D8. Le moteur ne dépend jamais d'Arc directement : il parle à cette
 *      interface, implémentée par `MockFxVenue` — déterministe, utilisé par le backtest —
 *      et par `ArcFxVenue`, adaptateur du RFQ natif.
 *
 *      Ce n'est pas un repli en cas d'accès refusé au RFQ : le backtest **exige** un lieu
 *      d'exécution déterministe et rejouable. Le mock est un livrable nécessaire, et le
 *      fait que backtest et production partagent la même interface est ce qui rend le
 *      backtest opposable — la politique testée est littéralement la politique exécutée.
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
     *      **Hypothèse d'atomicité.** Du point de vue de l'appelant, le débit de
     *      `tokenIn` et le crédit de `tokenOut` réussissent ou échouent ensemble. C'est
     *      ce qui élimine le risque de règlement Herstatt, et c'est la question posée à
     *      Arc au jalon 0 : si son PvP n'offre pas cette garantie, la machine à états du
     *      coffre doit gagner un état de compensation.
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

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title IFxVenue
 * @notice Execution venue for one FX leg.
 *
 * @dev Decision D8. The engine never depends on a particular venue: it talks to this
 *      interface, implemented by `MockFxVenue` — deterministic, used by the backtest.
 *
 *      This is not a fallback: the backtest **requires** a replayable execution venue, and
 *      the fact that backtest and execution share the same interface is what makes the
 *      backtest binding — the policy tested is literally the policy executed.
 *
 *      **What this interface does not describe: StableFX** (decision D21). Arc's FX engine
 *      is not called from a contract. Its flow has three stages — request a quote from
 *      several makers, accept off-chain for speed, then settle through escrow with Permit2
 *      and a typed-data intent confirmation. The corresponding adapter therefore lives
 *      off-chain, not here. This was verified in the documentation rather than assumed.
 */
interface IFxVenue {
    /**
     * @notice Indicative price for a given size.
     * @dev The `quoteId` binds execution to the quoted price. A real venue would sign that
     *      quote off-chain; the mock derives it from its current parameters, which is
     *      enough to detect execution at a price that is no longer the quoted one.
     */
    function quote(address tokenIn, address tokenOut, uint256 amountIn)
        external
        view
        returns (uint256 amountOut, uint64 quoteExpiry, bytes32 quoteId);

    /**
     * @notice Payment-versus-payment settlement.
     * @dev The caller must have approved `amountIn` of `tokenIn`.
     *
     *      **Atomicity.** From the caller's point of view, the `tokenIn` debit and the
     *      `tokenOut` credit succeed or fail together — which eliminates Herstatt
     *      settlement risk. This was an assumption to verify; the StableFX documentation
     *      confirms it for its PvP escrow ("both sides complete or neither does"). The
     *      vault state machine therefore needs no compensation state (D20).
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

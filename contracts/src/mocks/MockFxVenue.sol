// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IFxVenue} from "../interfaces/IFxVenue.sol";
import {MockERC20} from "./MockERC20.sol";

/**
 * @title MockFxVenue
 * @notice A deterministic execution venue: configurable mid price, spread, and impact in
 *         the square root of size.
 *
 * @dev The impact model matches the off-chain engine's:
 *
 *          relative_cost = spread + eta · √(size / depth)
 *
 *      The square root is not decorative — it is the classic empirical form of market
 *      impact, and its concavity means the *marginal* cost falls with size while the
 *      *total* cost grows faster than linearly. That is what makes the trade-off between
 *      rare large orders and frequent small ones non-trivial.
 *
 *      `eta` is uncalibrated (SPEC §4.6): Arc's real book depth is unknown. It is
 *      therefore configurable, and its value must be displayed with any number derived
 *      from it.
 *
 *      Both tokens are assumed to have six decimals, like USDC.
 */
contract MockFxVenue is IFxVenue {
    uint256 private constant WAD = 1e18;
    uint256 private constant BPS = 10_000;

    struct Pair {
        /// @dev Units of tokenOut per unit of tokenIn, in WAD.
        uint256 rateWad;
        uint16 spreadBps;
        /// @dev Impact coefficient, in basis points at full depth.
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
        // precision on small amounts, and a treasury engine places orders
        // dont la taille varie de plusieurs ordres de grandeur.
        amountOut = amountIn * p.rateWad * (BPS - costBps) / (WAD * BPS);
        quoteExpiry = _toUint64(block.timestamp) + quoteTtl;
        quoteId = keccak256(abi.encode(tokenIn, tokenOut, amountIn, amountOut, quoteExpiry));
    }

    /// @inheritdoc IFxVenue
    function settlePvP(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address to,
        bytes32 quoteId
    ) external returns (uint256 amountOut) {
        bytes32 expected;
        (amountOut,, expected) = quote(tokenIn, tokenOut, amountIn);

        // The executed price must be the quoted one. Without this check, a book that
        // emptied between quote and execution would fill at the worst available price.
        if (expected != quoteId) revert QuoteMismatch(expected, quoteId);
        if (amountOut < minAmountOut) revert SlippageExceeded(amountOut, minAmountOut);

        // The event precedes the external calls: otherwise a re-entrant call could
        // reorder or fabricate logs that off-chain consumers rely on. If a transfer fails,
        // the whole transaction reverts and the event disappears with it.
        emit Settled(tokenIn, tokenOut, amountIn, amountOut);

        // Debit and credit in the same call: this is the interface's atomicity assumption.
        if (!MockERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn)) {
            revert TransferFailed(tokenIn);
        }
        if (!MockERC20(tokenOut).transfer(to, amountOut)) revert TransferFailed(tokenOut);
    }

    /* ---------------------------------------------------------------- */

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
        // The linter flags every narrowing cast. Here the preceding line *is* the guard
        // that makes it safe — that is the whole point of this function.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint64(v);
    }

    /// @dev Integer square root by the Babylonian method.
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

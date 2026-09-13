/**
 * ABI fragment handed to Privy for decoding calldata.
 *
 * Deliberately narrowed to the functions the policies allow: Privy only needs to decode
 * what it rules on, and a full ABI would expose the policy engine to functions no rule
 * mentions.
 */

export const VAULT_ABI_FRAGMENT: readonly unknown[] = [
  {
    type: 'function',
    name: 'submit',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'report',
        type: 'tuple',
        components: [
          { name: 'epoch', type: 'uint64' },
          { name: 'nonce', type: 'uint64' },
          { name: 'expiry', type: 'uint64' },
          { name: 'inputsTimestamp', type: 'uint64' },
          { name: 'policyVersion', type: 'uint32' },
          { name: 'bandParamsHash', type: 'bytes32' },
          { name: 'inputsHash', type: 'bytes32' },
          { name: 'ordersCommitment', type: 'bytes32' },
          { name: 'esBeforeBps', type: 'int32' },
          { name: 'esAfterBps', type: 'int32' },
          { name: 'costEstimate', type: 'uint128' },
          { name: 'grossNotional', type: 'uint128' },
        ],
      },
      { name: 'attestation', type: 'bytes' },
      { name: 'signatures', type: 'bytes[]' },
    ],
    outputs: [{ name: 'id', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'id', type: 'bytes32' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'execute',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'id', type: 'bytes32' },
      {
        name: 'orders',
        type: 'tuple[]',
        components: [
          { name: 'sell', type: 'address' },
          { name: 'buy', type: 'address' },
          { name: 'amountIn', type: 'uint128' },
          { name: 'minAmountOut', type: 'uint128' },
        ],
      },
      { name: 'salt', type: 'bytes32' },
    ],
    outputs: [],
  },
] as const;

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Observation, Outcome} from "./StapleTypes.sol";

/// EIP-712 verification for keeper-signed book observations (BookSource) and outcome batches (OutcomeSink).
/// Signatures authenticate the reporter only; they do not prove the reported data is true.
abstract contract SignedReports {
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant OBSERVATION_TYPEHASH = keccak256(
        "Observation(uint256 mandateId,uint64 seq,uint64 sourceTimeMs,uint64 bestBidE8,uint64 bestAskE8,uint64 extBidDepthLots,uint64 extAskDepthLots,uint64 markE8,uint128 baseBalE8,uint128 quoteBalE8,uint32 unreportedFills)"
    );
    bytes32 internal constant OUTCOME_BATCH_TYPEHASH =
        keccak256("OutcomeBatch(uint256 mandateId,uint64 batchSeq,bytes32 outcomesHash)");

    // secp256k1n / 2, rejects malleable signatures
    uint256 private constant HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    error BadSignature();

    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("Staple"), keccak256("1"), block.chainid, address(this))
        );
    }

    function observationDigest(Observation calldata o) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                OBSERVATION_TYPEHASH,
                o.mandateId,
                o.seq,
                o.sourceTimeMs,
                o.bestBidE8,
                o.bestAskE8,
                o.extBidDepthLots,
                o.extAskDepthLots,
                o.markE8,
                o.baseBalE8,
                o.quoteBalE8,
                o.unreportedFills
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function outcomesHash(Outcome[] calldata outs) public pure returns (bytes32) {
        return keccak256(abi.encode(outs));
    }

    function outcomeBatchDigest(uint256 mandateId, uint64 batchSeq, Outcome[] calldata outs)
        public
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(abi.encode(OUTCOME_BATCH_TYPEHASH, mandateId, batchSeq, outcomesHash(outs)));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function _recover(bytes32 digest, bytes calldata sig) internal pure returns (address signer) {
        if (sig.length != 65) revert BadSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (uint256(s) > HALF_N || (v != 27 && v != 28)) revert BadSignature();
        signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert BadSignature();
    }
}

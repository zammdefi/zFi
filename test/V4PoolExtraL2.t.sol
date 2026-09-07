// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import {Test} from "forge-std/Test.sol";
import {TokenList} from "../src/utils/TokenList.sol";

interface IV4QuoteLens {
    function quoteV4Hooked(bool, address, address, uint24, int24, address, uint256)
        external
        returns (uint256, uint256);
}

/// @notice A v4 pool key published on a FOREIGN listing, end to end.
///
/// @dev THE PATH THIS COVERS, AND WHY EACH JOINT CAN BREAK SILENTLY.
///
///      multisig calldata -> registry -> renderer JSON -> the page's parser.
///
///      1. The key is `keccak256("zfi.v4pool")`, not `bytes32("zfi.v4pool")`.
///         The renderer prints an all-printable-ASCII key as a WORD and anything
///         else as HEX, and the page matches the hex. Written as a word, the
///         extra stores fine, renders fine, and the pool is invisible forever.
///      2. The value goes in as a string and comes back through a renderer that
///         DROPS characters it will not emit. A pool key sheared mid-address
///         routes nowhere while still looking like a listing that has one.
///      3. `setExtra` TRUNCATES past 256 characters rather than reverting.
///      4. And the pool the key names has to actually trade - on the chain the
///         listing is FOR, not the chain the registry is on.
///
///      So this replays the real batch on a mainnet fork, reads the extra back
///      out of `json(id)` exactly as the page fetches it, and then quotes that
///      pool through the deployed lens ON BASE. Neither half is worth much
///      alone: a key that round-trips into a dead pool is still a dead route.
contract V4PoolExtraL2Test is Test {
    address constant REG = 0x0000006013dF75A31678B786061C2B54bf531524;
    address constant SAFE = 0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2;
    address constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant LENS = 0x00000000Dc6f467A7AA88e216a904Cf758453EbC;
    uint64 constant BASE = 8453;

    /// @dev keccak256("zfi.v4pool"), as the renderer prints it.
    string constant KEY_HEX = "0x95a932c205571d4d1ca72715c642a2eca21dde79ffc28ff11509681f9383385f";
    string constant SPEC = "v1:0:3000:10:0";

    function test_BaseBatchPublishesTheV4PoolKey() public {
        vm.createSelectFork(vm.envOr("ETH_RPC_URL", string("https://ethereum-rpc.publicnode.com")));
        bytes memory cd = vm.parseBytes(vm.replace(vm.readFile("./deploy/BASE-list.calldata.txt"), "\n", ""));
        TokenList reg = TokenList(payable(REG));
        uint256 id = reg.idOf(TokenList.Kind.EVM, BASE, bytes32(uint256(uint160(BASE_USDC))));

        if (!reg.isListed(id)) {
            vm.prank(SAFE);
            (bool ok,) = REG.call(cd);
            assertTrue(ok, "batch reverted");
        }

        // Read it the way the page does: one `json(id)`, no second call.
        string memory js = reg.json(id);
        assertTrue(_has(js, string.concat('{"k":"', KEY_HEX, '","v":"', SPEC, '"}')), "the pool key is not in json(id) as the page reads it");
        // The key must NOT appear as the word - that is the failure mode where
        // everything looks written and nothing is ever read.
        assertFalse(_has(js, '"k":"zfi.v4pool"'), "key stored as a word, not the hash");
    }

    /// @dev The other half: the pool that key names trades on Base, through the
    ///      deployed lens, at a (fee, tickSpacing) the four-tier sweep never asks
    ///      for - which is the entire reason it has to be published at all.
    function test_ThePublishedPoolQuotesThroughTheDeployedLens() public {
        vm.createSelectFork(vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org")));
        (uint256 amountIn, uint256 amountOut) =
            IV4QuoteLens(LENS).quoteV4Hooked(false, address(0), BASE_USDC, 3000, 10, address(0), 0.01 ether);
        assertEq(amountIn, 0.01 ether);
        assertGt(amountOut, 0, "the published Base pool quoted nothing");
        assertGt(amountOut, 10_000);
        assertLt(amountOut, 1e12);
    }

    function _has(string memory haystack, string memory needle) internal pure returns (bool) {
        bytes memory h = bytes(haystack);
        bytes memory n = bytes(needle);
        if (n.length == 0 || n.length > h.length) return false;
        for (uint256 i; i <= h.length - n.length; ++i) {
            bool same = true;
            for (uint256 j; j < n.length; ++j) {
                if (h[i + j] != n[j]) { same = false; break; }
            }
            if (same) return true;
        }
        return false;
    }
}

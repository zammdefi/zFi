// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import {Test} from "forge-std/Test.sol";
import {TokenList} from "../src/utils/TokenList.sol";

/// @notice The artwork batch, replayed and read back.
///
/// @dev `setLogoSVG` does not store what it is given: it base64s the markup into
///      a `data:image/svg+xml` URI and stores that. So "did it work" is not "did
///      the call succeed" - it is whether the stored URI decodes back to the
///      exact bytes that went in, and whether the page's own `safeDataUrl`
///      pattern would accept the result rather than falling back to a generated
///      initial. Both are asserted here, per listing.
contract LogoBatchTest is Test {
    address constant REG = 0x0000006013dF75A31678B786061C2B54bf531524;
    address constant SAFE = 0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2;

    struct Art { uint64 chainId; address token; string file; }

    function test_LogosLandAndReadBack() public {
        vm.createSelectFork(vm.envOr("ETH_RPC_URL", string("https://ethereum-rpc.publicnode.com")));
        bytes memory cd = vm.parseBytes(vm.replace(vm.readFile("./deploy/LOGOS-list.calldata.txt"), "\n", ""));
        TokenList reg = TokenList(payable(REG));

        Art[7] memory art = [
            Art(4663, 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168, "./dapp/assets/usdg.svg"),
            Art(4663, 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC, "./dapp/assets/nvda.svg"),
            Art(4663, 0x01637b14B7378B99dE75A64d50656d98488D9a4d, "./dapp/assets/marian.svg"),
            Art(4663, 0xbfb7b3Ff3D498a559b946B836d26F0E168f273D5, "./dapp/assets/state.svg"),
            Art(8453, 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf, "./dapp/assets/cbbtc.svg"),
            Art(8453, 0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22, "./dapp/assets/cbeth.svg"),
            Art(8453, 0x940181a94A35A4569E4529A3CDfB74e38FD98631, "./dapp/assets/aero.svg")
        ];

        // Every one of these draws a generated initial today; that is the point.
        for (uint256 i; i < art.length; ++i) {
            uint256 id = reg.idOf(TokenList.Kind.EVM, art[i].chainId, bytes32(uint256(uint160(art[i].token))));
            assertEq(bytes(reg.logoOf(id)).length, 0, "expected no art before the batch");
        }

        vm.prank(SAFE);
        (bool ok,) = REG.call(cd);
        assertTrue(ok, "batch reverted");

        for (uint256 i; i < art.length; ++i) {
            uint256 id = reg.idOf(TokenList.Kind.EVM, art[i].chainId, bytes32(uint256(uint160(art[i].token))));
            string memory stored = reg.logoOf(id);
            bytes memory b = bytes(stored);
            assertGt(b.length, 0, "no art stored");
            // The page accepts `data:image/<type>;base64,<base64>` and nothing else.
            assertTrue(_starts(stored, "data:image/svg+xml;base64,"), "not the data URI the page accepts");
            // And it must be the exact source, not a re-encoding of something else.
            string memory src = vm.replace(vm.readFile(art[i].file), "\n", "");
            assertEq(
                stored,
                string.concat("data:image/svg+xml;base64,", vm.toBase64(bytes(src))),
                "stored art is not the source svg"
            );
            emit log_named_uint(art[i].file, b.length);
        }
    }

    function _starts(string memory s, string memory pre) internal pure returns (bool) {
        bytes memory a = bytes(s); bytes memory p = bytes(pre);
        if (p.length > a.length) return false;
        for (uint256 i; i < p.length; ++i) if (a[i] != p[i]) return false;
        return true;
    }
}

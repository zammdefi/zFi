// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import {Test} from "forge-std/Test.sol";
import {TokenList} from "../src/utils/TokenList.sol";

/// @notice Applies a listing batch on a mainnet fork and prints the registry's
///         OWN `json(id)` for every row the page would read, in ranked order.
///
/// @dev The point is to stop guessing what the page will see. Everything else
///      checks the batch; this produces the exact bytes `loadTokenListRun`
///      fetches, so they can be fed to the real page and the dropdown observed
///      rather than predicted. Paired with `script/simulate-dropdown.mjs`.
contract ListingDumpTest is Test {
    address constant REG = 0x0000006013dF75A31678B786061C2B54bf531524;
    address constant SAFE = 0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2;

    function test_Dump() public {
        vm.createSelectFork(vm.envOr("ETH_RPC_URL", string("https://ethereum-rpc.publicnode.com")));
        bytes memory cd = vm.parseBytes(vm.replace(vm.readFile(vm.envString("FOREIGN_LISTING")), "\n", ""));
        TokenList reg = TokenList(payable(REG));
        vm.prank(SAFE);
        (bool ok,) = REG.call(cd);
        require(ok, "batch reverted");

        // Ranked order, and the same window the page takes.
        uint256[] memory ids = reg.rankedIds();
        for (uint256 i; i < ids.length; ++i) {
            emit log_string(string.concat("ROW ", reg.json(ids[i])));
        }
    }
}

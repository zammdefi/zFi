// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

/// @notice Minimal ERC20 interface (compatible with stETH).
interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}

/// @notice Lido stETH has a payable submit() entrypoint for ETH -> stETH.
interface IStETH is IERC20 {
    function submit(address referral) external payable returns (uint256);
}

/// @notice Safe ERC20 helpers (handles tokens that return no bool).
library SafeERC20 {
    error ERC20CallFailed();
    error ERC20BadReturn();

    function safeTransfer(IERC20 token, address to, uint256 amount) internal {
        bytes memory data = abi.encodeWithSelector(token.transfer.selector, to, amount);
        _callOptionalReturn(address(token), data);
    }

    function safeTransferFrom(IERC20 token, address from, address to, uint256 amount) internal {
        bytes memory data = abi.encodeWithSelector(token.transferFrom.selector, from, to, amount);
        _callOptionalReturn(address(token), data);
    }

    function safeApprove(IERC20 token, address spender, uint256 amount) internal {
        bytes memory data = abi.encodeWithSelector(token.approve.selector, spender, amount);
        _callOptionalReturn(address(token), data);
    }

    function _callOptionalReturn(address token, bytes memory data) private {
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok) revert ERC20CallFailed();
        if (ret.length == 0) return; // non-standard ERC20: assume success
        if (ret.length == 32) {
            if (!abi.decode(ret, (bool))) revert ERC20BadReturn();
            return;
        }
        revert ERC20BadReturn();
    }
}

/// @notice Harvest-only-yield executor for Lido stETH.
/// @dev Tracks principal as `principalStETH`. Rebase increases show up as "yield":
///      yield = stETH.balanceOf(this) - principalStETH (if positive).
///      `harvest()` can spend up to the yield (never principal), and can enforce that
///      some external holder's ETH/ERC20 balance increases by at least `minIncrease`.
contract LidoYieldExecutor {
    using SafeERC20 for IERC20;

    // Mainnet stETH. Change if deploying on a different chain.
    address public constant STETH = 0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84;

    // --- Access control ---
    address public owner;
    mapping(address => bool) public keeper;

    // --- Principal tracking ---
    uint256 public principalStETH;

    // --- Condition: require some balance increase elsewhere ---
    // If conditionHolder == address(0), condition is disabled.
    // If conditionAsset == address(0), checks ETH balance; otherwise checks ERC20 balance.
    address public conditionAsset;
    address public conditionHolder;
    uint256 public minIncrease;

    // --- Reentrancy guard ---
    uint256 private _status; // 1 = not entered, 2 = entered

    // --- Events ---
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event KeeperSet(address indexed keeper, bool allowed);
    event ConditionSet(address indexed asset, address indexed holder, uint256 minIncrease);

    event DepositedETH(address indexed from, uint256 ethIn, uint256 stEthMinted, uint256 principalAfter);
    event DepositedStETH(address indexed from, uint256 stEthIn, uint256 principalAfter);

    event PrincipalSynced(uint256 oldPrincipal, uint256 newPrincipal);

    event HarvestExecuted(
        address indexed caller,
        address indexed target,
        address indexed spender,
        uint256 stEthSpent,
        uint256 yieldBefore,
        uint256 principal,
        address conditionAsset,
        address conditionHolder,
        uint256 conditionBefore,
        uint256 conditionAfter
    );

    // --- Errors ---
    error Unauthorized();
    error Reentrancy();
    error InvalidParams();
    error CallFailed();
    error ConditionUnmet();
    error PrincipalTouched();
    error DirectStEthCallBlocked();

    // --- Internal access checks ---
    function _onlyOwner() internal view {
        if (msg.sender != owner) revert Unauthorized();
    }

    function _onlyOwnerOrKeeper() internal view {
        if (msg.sender != owner && !keeper[msg.sender]) revert Unauthorized();
    }

    function _enter() internal {
        if (_status == 2) revert Reentrancy();
        _status = 2;
    }

    function _exit() internal {
        _status = 1;
    }

    constructor() payable {
        owner = msg.sender;
        _status = 1;
        emit OwnershipTransferred(address(0), msg.sender);

        // Optional: allow constructor ETH funding to be staked immediately
        if (msg.value != 0) {
            _enter();
            uint256 minted = _stakeETH(msg.value);
            emit DepositedETH(msg.sender, msg.value, minted, principalStETH);
            _exit();
        }
    }

    /// @notice Plain ETH sends: stake to stETH and increase principal
    ///         *unless* we are in the middle of a protected operation (e.g. harvest),
    ///         in which case we must accept ETH quietly (common for swap routers paying ETH out).
    receive() external payable {
        if (msg.value == 0) return;

        // Critical: swaps often pay ETH to this contract during harvest().
        // If we tried to stake here while _status==2, we'd revert and break harvest.
        if (_status == 2) return;

        _enter();
        uint256 minted = _stakeETH(msg.value);
        emit DepositedETH(msg.sender, msg.value, minted, principalStETH);
        _exit();
    }

    // -------------------------
    // Admin
    // -------------------------

    function transferOwnership(address newOwner) external {
        _onlyOwner();
        if (newOwner == address(0)) revert InvalidParams();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setKeeper(address k, bool allowed) external {
        _onlyOwner();
        keeper[k] = allowed;
        emit KeeperSet(k, allowed);
    }

    /// @notice Configure the balance-increase condition for harvest().
    /// @param asset address(0) = ETH; otherwise ERC20 token address
    /// @param holder address whose balance must increase (set to address(0) to disable)
    /// @param _minIncrease minimum increase required (in wei or token units)
    function setCondition(address asset, address holder, uint256 _minIncrease) external {
        _onlyOwner();
        conditionAsset = asset;
        conditionHolder = holder;
        minIncrease = _minIncrease;
        emit ConditionSet(asset, holder, _minIncrease);
    }

    /// @notice Emergency tool: if stETH balance ever drops below principal (loss/slashing or operator mistake),
    ///         resync principal to current balance so the contract can continue operating.
    /// @dev This acknowledges the loss publicly via event.
    function syncPrincipalToBalance() external {
        _onlyOwner();
        uint256 bal = IERC20(STETH).balanceOf(address(this));
        uint256 old = principalStETH;
        principalStETH = bal;
        emit PrincipalSynced(old, bal);
    }

    // -------------------------
    // Deposits
    // -------------------------

    /// @notice Deposit ETH and stake it to stETH, increasing principal.
    function depositETH() external payable {
        if (msg.value == 0) revert InvalidParams();
        _enter();
        uint256 minted = _stakeETH(msg.value);
        emit DepositedETH(msg.sender, msg.value, minted, principalStETH);
        _exit();
    }

    /// @notice Deposit stETH, increasing principal by the amount received.
    function depositStETH(uint256 amount) external {
        if (amount == 0) revert InvalidParams();
        _enter();

        uint256 beforeBal = IERC20(STETH).balanceOf(address(this));
        IERC20(STETH).safeTransferFrom(msg.sender, address(this), amount);
        uint256 afterBal = IERC20(STETH).balanceOf(address(this));

        uint256 received = afterBal - beforeBal;
        principalStETH += received;

        emit DepositedStETH(msg.sender, received, principalStETH);
        _exit();
    }

    // -------------------------
    // Views
    // -------------------------

    function stEthBalance() public view returns (uint256) {
        return IERC20(STETH).balanceOf(address(this));
    }

    function yieldStETH() public view returns (uint256) {
        uint256 bal = IERC20(STETH).balanceOf(address(this));
        if (bal <= principalStETH) return 0;
        return bal - principalStETH;
    }

    // -------------------------
    // Harvest / Execute using yield only
    // -------------------------

    /// @notice Execute an external call while proving on-chain that no stETH principal was spent.
    ///
    /// Invariants enforced (publicly auditable):
    ///  1) stETHAfter >= principalStETH
    ///  2) stETHSpent = max(stBefore - stAfter, 0) <= yieldBefore
    ///  3) If condition enabled: holder's ETH/ERC20 balance increased by >= minIncrease
    ///
    /// @param target contract to call (cannot be STETH directly)
    /// @param spender address to approve for stETH pull (e.g., swap router). Use address(0) if maxStETHToSpend == 0.
    /// @param maxStETHToSpend maximum stETH this call may spend (pulled via allowance). Must be <= yield before.
    /// @param ethValue ETH to attach to the call (usually 0; comes from this contract's ETH balance).
    /// @param data calldata for the external call.
    function harvest(address target, address spender, uint256 maxStETHToSpend, uint256 ethValue, bytes calldata data)
        external
        returns (uint256 stEthSpent, uint256 yieldBefore)
    {
        _onlyOwnerOrKeeper();
        _enter();

        if (target == address(0)) revert InvalidParams();
        if (target == STETH) revert DirectStEthCallBlocked(); // avoids obvious approval/drain footguns

        uint256 stBefore = IERC20(STETH).balanceOf(address(this));
        uint256 principal = principalStETH;

        yieldBefore = (stBefore > principal) ? (stBefore - principal) : 0;
        if (maxStETHToSpend > yieldBefore) revert InvalidParams();

        // Snapshot the condition target balance (if enabled)
        address h = conditionHolder;
        address a = conditionAsset;
        uint256 condBefore = 0;
        bool conditioned = (h != address(0));
        if (conditioned) {
            condBefore = (a == address(0)) ? h.balance : IERC20(a).balanceOf(h);
        }

        // Approve exactly what the call is allowed to spend (bounded by yieldBefore)
        if (maxStETHToSpend != 0) {
            if (spender == address(0)) revert InvalidParams();
            if (spender == STETH) revert InvalidParams();

            IERC20(STETH).safeApprove(spender, 0);
            IERC20(STETH).safeApprove(spender, maxStETHToSpend);
        }

        if (ethValue != 0 && address(this).balance < ethValue) revert InvalidParams();

        (bool ok,) = target.call{value: ethValue}(data);
        if (!ok) revert CallFailed();

        // Reset approval to prevent post-call pull
        if (maxStETHToSpend != 0) {
            IERC20(STETH).safeApprove(spender, 0);
        }

        uint256 stAfter = IERC20(STETH).balanceOf(address(this));

        // Enforce "principal untouched"
        if (stAfter < principal) revert PrincipalTouched();

        // Enforce "spent <= yieldBefore"
        stEthSpent = (stBefore > stAfter) ? (stBefore - stAfter) : 0;
        if (stEthSpent > yieldBefore) revert PrincipalTouched();

        // Enforce condition (if enabled)
        uint256 condAfter = 0;
        if (conditioned) {
            condAfter = (a == address(0)) ? h.balance : IERC20(a).balanceOf(h);
            if (condAfter < condBefore + minIncrease) revert ConditionUnmet();
        }

        emit HarvestExecuted(
            msg.sender, target, spender, stEthSpent, yieldBefore, principal, a, h, condBefore, condAfter
        );

        _exit();
    }

    // -------------------------
    // Optional owner-only helpers
    // -------------------------

    /// @notice Withdraw stETH yield only (never principal).
    function withdrawYieldStETH(address to, uint256 amount) external {
        _onlyOwner();
        if (to == address(0)) revert InvalidParams();
        _enter();

        uint256 y = yieldStETH();
        if (amount > y) revert InvalidParams();

        IERC20(STETH).safeTransfer(to, amount);

        if (IERC20(STETH).balanceOf(address(this)) < principalStETH) revert PrincipalTouched();

        _exit();
    }

    /// @notice Withdraw ETH from the contract (e.g., dust/forced ETH). Does not affect stETH principal.
    function withdrawETH(address payable to, uint256 amount) external {
        _onlyOwner();
        if (to == address(0)) revert InvalidParams();
        _enter();

        if (address(this).balance < amount) revert InvalidParams();
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert CallFailed();

        _exit();
    }

    /// @notice Rescue arbitrary tokens accidentally sent to this contract (excluding stETH).
    function rescueToken(address token, address to, uint256 amount) external {
        _onlyOwner();
        if (token == STETH) revert InvalidParams();
        if (to == address(0)) revert InvalidParams();
        IERC20(token).safeTransfer(to, amount);
    }

    // -------------------------
    // Internals
    // -------------------------

    function _stakeETH(uint256 amount) internal returns (uint256 minted) {
        uint256 beforeBal = IERC20(STETH).balanceOf(address(this));
        IStETH(STETH).submit{value: amount}(address(0));
        uint256 afterBal = IERC20(STETH).balanceOf(address(this));
        minted = afterBal - beforeBal;
        principalStETH += minted;
    }
}

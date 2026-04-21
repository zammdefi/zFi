// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

/// @title DutchAuction
/// @notice Dutch auction (linear price decay) for a single NFT, a bundle of NFTs,
///         or an ERC20 amount, settled in ETH. Partial fills are supported for
///         ERC20 listings (useful as a price-discovery token sale). Seller can
///         cancel and reclaim the unsold portion at any time.
/// @dev    Assets are escrowed on listing. The listed `startPrice`/`endPrice`
///         is the total ETH for the full initial lot; the price decays linearly
///         from `startPrice` at `startTime` to `endPrice` at `startTime+duration`
///         and is flat outside that window (`endPrice` may be 0). For ERC20
///         partial fills, taking `take` units costs `ceil(priceOf(id) * take / initial)`
///         (rounded up, so tiny buys can't round to 0 when `initial >> price`).
contract DutchAuction {
    struct Auction {
        address seller;
        address token;
        uint40 startTime;
        uint40 duration;
        uint128 startPrice;
        uint128 endPrice;
        uint128 initial; // ERC20 only; 0 for NFT
        uint128 remaining; // ERC20 only; 0 for NFT
        uint256[] ids; // NFT only; empty for ERC20
    }

    uint256 public nextId;
    mapping(uint256 => Auction) public auctions;

    event Created(uint256 indexed id, address indexed seller);
    event Filled(uint256 indexed id, address indexed buyer, uint256 amount, uint256 paid);
    event Cancelled(uint256 indexed id);

    error Bad();
    error NotSeller();
    error Reentrancy();
    error Insufficient();
    error TransferFailed();

    uint256 constant _REENTRANCY_GUARD_SLOT = 0x929eee149b4bd21268;

    modifier nonReentrant() {
        assembly ("memory-safe") {
            if tload(_REENTRANCY_GUARD_SLOT) {
                mstore(0x00, 0xab143c06) // Reentrancy()
                revert(0x1c, 0x04)
            }
            tstore(_REENTRANCY_GUARD_SLOT, address())
        }
        _;
        assembly ("memory-safe") {
            tstore(_REENTRANCY_GUARD_SLOT, 0)
        }
    }

    /// @notice List one or more NFTs from a single ERC721 contract as one lot.
    ///         Caller must approve this contract for every id in `ids`.
    function listNFT(
        address token,
        uint256[] calldata ids,
        uint128 startPrice,
        uint128 endPrice,
        uint40 startTime,
        uint40 duration
    ) public nonReentrant returns (uint256 id) {
        if (ids.length == 0 || duration == 0 || startPrice < endPrice) revert Bad();
        unchecked {
            id = nextId++;
        }
        Auction storage a = auctions[id];
        a.seller = msg.sender;
        a.token = token;
        a.startTime = startTime == 0 ? uint40(block.timestamp) : startTime;
        a.duration = duration;
        a.startPrice = startPrice;
        a.endPrice = endPrice;
        a.ids = ids;
        for (uint256 i; i < ids.length; ++i) {
            IERC721(token).transferFrom(msg.sender, address(this), ids[i]);
        }
        emit Created(id, msg.sender);
    }

    /// @notice List an ERC20 amount for sale. Partial fills are allowed.
    ///         Caller must approve this contract for `amount`. Only plain ERC20s
    ///         are supported; fee-on-transfer and rebasing tokens are out of scope.
    function listERC20(
        address token,
        uint128 amount,
        uint128 startPrice,
        uint128 endPrice,
        uint40 startTime,
        uint40 duration
    ) public nonReentrant returns (uint256 id) {
        if (amount == 0 || duration == 0 || startPrice < endPrice) revert Bad();
        unchecked {
            id = nextId++;
        }
        Auction storage a = auctions[id];
        a.seller = msg.sender;
        a.token = token;
        a.startTime = startTime == 0 ? uint40(block.timestamp) : startTime;
        a.duration = duration;
        a.startPrice = startPrice;
        a.endPrice = endPrice;
        a.initial = amount;
        a.remaining = amount;
        _safeTransferFrom(token, msg.sender, address(this), amount);
        emit Created(id, msg.sender);
    }

    /// @notice Current total price for the full initial lot at `block.timestamp`.
    ///         Returns 0 for unknown/closed listings.
    function priceOf(uint256 id) public view returns (uint256) {
        Auction storage a = auctions[id];
        if (block.timestamp <= a.startTime) return a.startPrice;
        unchecked {
            // block.timestamp > a.startTime (guarded above).
            uint256 elapsed = block.timestamp - a.startTime;
            if (elapsed >= a.duration) return a.endPrice;
            // startPrice >= endPrice (enforced at listing); (diff <= 2^128) * (elapsed < 2^40) fits in uint256.
            // Fraction < (startPrice - endPrice) since elapsed < duration, so outer subtraction cannot underflow.
            return a.startPrice - ((uint256(a.startPrice) - a.endPrice) * elapsed) / a.duration;
        }
    }

    /// @notice Fill a listing with ETH.
    /// @dev    NFT bundles: pass `take == 0` or `take == ids.length`; the whole lot is
    ///         bought at `priceOf`. Mismatched `take` reverts to avoid buyer confusion.
    ///         ERC20: buys `take` units for `ceil(priceOf * take / initial)`.
    function fill(uint256 id, uint128 take) public payable nonReentrant {
        Auction storage a = auctions[id];
        address seller = a.seller;
        if (seller == address(0)) revert Bad();
        uint256 price = priceOf(id);
        address token = a.token;

        if (a.ids.length != 0) {
            if (take != 0 && take != a.ids.length) revert Bad();
            if (msg.value < price) revert Insufficient();
            uint256[] memory ids = a.ids;
            uint256 n = ids.length;
            delete auctions[id];
            for (uint256 i; i < n; ++i) {
                IERC721(token).transferFrom(address(this), msg.sender, ids[i]);
            }
            _pay(seller, price);
            unchecked {
                if (msg.value > price) _pay(msg.sender, msg.value - price);
            }
            emit Filled(id, msg.sender, n, price);
        } else {
            if (take == 0 || take > a.remaining) revert Bad();
            uint256 cost;
            unchecked {
                // Ceiling division: prevents cost=0 when initial >> price.
                cost = (price * take + a.initial - 1) / a.initial;
            }
            if (msg.value < cost) revert Insufficient();
            unchecked {
                uint128 newRem = a.remaining - take;
                if (newRem == 0) delete auctions[id];
                else a.remaining = newRem;
            }
            _safeTransfer(token, msg.sender, take);
            _pay(seller, cost);
            unchecked {
                if (msg.value > cost) _pay(msg.sender, msg.value - cost);
            }
            emit Filled(id, msg.sender, take, cost);
        }
    }

    /// @notice Seller closes the listing and reclaims the unsold portion.
    function cancel(uint256 id) public nonReentrant {
        Auction storage a = auctions[id];
        if (a.seller != msg.sender) revert NotSeller();
        address token = a.token;
        if (a.ids.length != 0) {
            uint256[] memory ids = a.ids;
            delete auctions[id];
            for (uint256 i; i < ids.length; ++i) {
                IERC721(token).transferFrom(address(this), msg.sender, ids[i]);
            }
        } else {
            uint256 rem = a.remaining;
            delete auctions[id];
            if (rem != 0) _safeTransfer(token, msg.sender, rem);
        }
        emit Cancelled(id);
    }

    /// @notice NFT ids in a listing (the public mapping getter omits dynamic arrays).
    function idsOf(uint256 id) public view returns (uint256[] memory) {
        return auctions[id].ids;
    }

    // ---------- internal ----------

    function _pay(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function _safeTransfer(address token, address to, uint256 amount) internal {
        if (token.code.length == 0) revert TransferFailed();
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        if (token.code.length == 0) revert TransferFailed();
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0x23b872dd, from, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}

interface IERC721 {
    function transferFrom(address from, address to, uint256 id) external;
}

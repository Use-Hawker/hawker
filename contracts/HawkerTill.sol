// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
}

interface IUSDG {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/// @title HAWKER till: pay-per-call settlement in USDG on Robinhood Chain.
/// @notice A buyer (an AI agent) signs a USDG ReceiveWithAuthorization made out to this contract for the price of one call.
/// Signing costs nothing and needs no deposit. Anyone can bring that signature here, and in one transaction the USDG
/// leaves the buyer, the seller gets it minus the fee, and the fee goes to the fee sink.
/// The seller is part of what the buyer signed: the authorization nonce is keccak256(seller, ref), so whoever submits
/// the payment cannot point it at another wallet. The contract holds nothing between transactions, and the owner
/// cannot move anyone's funds: it can only change the fee (up to MAX_FEE_BPS), where it goes and which token waives it.
contract HawkerTill {
    struct Payment {
        address from; // the buyer who signed
        address seller; // who gets paid
        uint256 value; // USDG units (6 decimals) the buyer pays
        uint256 validAfter;
        uint256 validBefore; // the signature is void from this time on
        bytes32 ref; // the call this pays for; with the seller it makes the nonce, so one ref pays once
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    uint256 public constant MAX_FEE_BPS = 500; // the fee can never be set above 5%
    address public immutable usdg;

    address public owner;
    address public feeSink;
    uint256 public feeBps;
    address public holderToken; // a seller holding holderMin of it pays no fee
    uint256 public holderMin;

    event Paid(bytes32 indexed ref, address indexed buyer, address indexed seller, uint256 value, uint256 fee);
    event Skipped(bytes32 indexed ref, address indexed buyer, address indexed seller);
    event FeeSet(uint256 feeBps);
    event FeeSinkSet(address feeSink);
    event HolderTokenSet(address token, uint256 min);
    event OwnerSet(address owner);

    error NotOwner();
    error NoSeller();
    error NotPaid();
    error FeeTooHigh();
    error TransferFailed();

    constructor(address usdg_, address feeSink_, uint256 feeBps_) {
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        usdg = usdg_;
        owner = msg.sender;
        feeSink = feeSink_;
        feeBps = feeBps_;
        emit OwnerSet(msg.sender);
        emit FeeSinkSet(feeSink_);
        emit FeeSet(feeBps_);
    }

    /// @notice The nonce a buyer must sign so the payment can only reach this seller for this call.
    function nonceFor(address seller, bytes32 ref) public pure returns (bytes32) {
        return keccak256(abi.encode(seller, ref));
    }

    function feeFor(address seller, uint256 value) public view returns (uint256) {
        if (holderToken != address(0) && _holds(seller)) return 0;
        return (value * feeBps) / 10_000;
    }

    /// @notice Lands one signed payment. Open to anyone: a wrong seller, value or ref breaks the buyer's signature.
    function settle(Payment calldata p) external {
        if (p.seller == address(0)) revert NoSeller();
        // USDG checks the signature and the time window, then moves the money here. On a nonce that was already used
        // it does not revert, it just moves nothing, so the till counts what actually arrived.
        uint256 before = IERC20(usdg).balanceOf(address(this));
        IUSDG(usdg).receiveWithAuthorization(p.from, address(this), p.value, p.validAfter, p.validBefore, nonceFor(p.seller, p.ref), p.v, p.r, p.s);
        if (IERC20(usdg).balanceOf(address(this)) - before != p.value) revert NotPaid();
        uint256 fee = feeFor(p.seller, p.value);
        _send(p.seller, p.value - fee);
        if (fee > 0) _send(feeSink, fee);
        emit Paid(p.ref, p.from, p.seller, p.value, fee);
    }

    /// @notice Lands many payments in one transaction. One that fails (spent, expired, empty wallet) is skipped
    /// and the rest still land.
    function settleMany(Payment[] calldata ps) external returns (uint256 landed) {
        for (uint256 i; i < ps.length; ++i) {
            try this.settle(ps[i]) {
                ++landed;
            } catch {
                emit Skipped(ps[i].ref, ps[i].from, ps[i].seller);
            }
        }
    }

    function setFee(uint256 bps) external {
        if (msg.sender != owner) revert NotOwner();
        if (bps > MAX_FEE_BPS) revert FeeTooHigh();
        feeBps = bps;
        emit FeeSet(bps);
    }

    function setFeeSink(address to) external {
        if (msg.sender != owner) revert NotOwner();
        feeSink = to;
        emit FeeSinkSet(to);
    }

    function setHolderToken(address token, uint256 min) external {
        if (msg.sender != owner) revert NotOwner();
        holderToken = token;
        holderMin = min;
        emit HolderTokenSet(token, min);
    }

    function setOwner(address to) external {
        if (msg.sender != owner) revert NotOwner();
        owner = to;
        emit OwnerSet(to);
    }

    function _holds(address who) private view returns (bool) {
        // a raw call, so a holder token that is not a contract or answers garbage cannot make payments revert
        (bool ok, bytes memory r) = holderToken.staticcall(abi.encodeWithSelector(IERC20.balanceOf.selector, who));
        return ok && r.length == 32 && abi.decode(r, (uint256)) >= holderMin;
    }

    function _send(address to, uint256 amount) private {
        (bool ok, bytes memory r) = usdg.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        if (!ok || (r.length > 0 && !abi.decode(r, (bool)))) revert TransferFailed();
    }
}

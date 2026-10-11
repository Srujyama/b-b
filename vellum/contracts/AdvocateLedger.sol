// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title AdvocateLedger — trusted-agent infrastructure for an AI advocate acting with a patient's money.
/// @notice Three things live on-chain per case:
///   1. a MANDATE — the patient (or guardian) authorises one agent address up to `maxAmountCents`,
///      bound to a hash of her consent record. Either sent by the patient key directly, or signed by the
///      patient off-chain (EIP-712) and relayed by anyone, so the authorisation is the patient's own signature.
///   2. a TAMPER-EVIDENT LOG — every offer / transcript turn is hashed off-chain and appended here as
///      head = keccak256(abi.encodePacked(prevHead, entryHash)). Re-hashing the off-chain entries must
///      reproduce `head`; any edited, dropped or reordered entry breaks it.
///   3. a DEAL — the agreed amount, transcript root and settlement reference (e.g. an XRPL tx hash).
///      recordDeal REVERTS if the amount exceeds the mandate: the limit is enforced by the chain, not a prompt.
contract AdvocateLedger {
    struct Mandate {
        address patient;
        address agent;
        uint256 maxAmountCents;
        bytes32 consentHash;
        uint64 openedAt;
        bool patientSigned; // true when opened via an EIP-712 patient signature
        bool revoked;
    }

    struct Deal {
        uint256 amountCents;
        bytes32 transcriptRoot;
        bytes32 logHead; // chain head at the moment the deal was recorded
        uint256 logCount;
        string settlementRef;
        uint64 recordedAt;
    }

    bytes32 public constant MANDATE_TYPEHASH = keccak256(
        "Mandate(bytes32 caseId,address agent,uint256 maxAmountCents,bytes32 consentHash,uint256 nonce,uint256 deadline)"
    );
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    mapping(bytes32 => Mandate) private _mandates;
    mapping(bytes32 => bytes32) public heads;
    mapping(bytes32 => uint256) public logCounts;
    mapping(bytes32 => Deal) private _deals;
    mapping(address => uint256) public nonces;

    event MandateOpened(
        bytes32 indexed caseId, address indexed patient, address indexed agent, uint256 maxAmountCents, bytes32 consentHash, bool patientSigned
    );
    event MandateRevoked(bytes32 indexed caseId);
    event LogAppended(bytes32 indexed caseId, uint256 indexed index, bytes32 entryHash, bytes32 head);
    event DealRecorded(bytes32 indexed caseId, uint256 amountCents, bytes32 transcriptRoot, bytes32 logHead, string settlementRef);

    error MandateExists();
    error NoMandate();
    error MandateIsRevoked();
    error NotAuthorized();
    error OverMandate(uint256 amountCents, uint256 maxAmountCents);
    error DealExists();
    error BadSignature();
    error Expired();
    error ZeroAgent();

    // ---------------------------------------------------------------- mandate

    /// @notice Patient/guardian opens the mandate with their own key (msg.sender is the patient).
    function openMandate(bytes32 caseId, address agent, uint256 maxAmountCents, bytes32 consentHash) external {
        _open(caseId, msg.sender, agent, maxAmountCents, consentHash, false);
    }

    /// @notice Anyone relays a mandate the patient signed off-chain (EIP-712); the signer becomes the patient.
    function openMandateWithSig(
        bytes32 caseId,
        address patient,
        address agent,
        uint256 maxAmountCents,
        bytes32 consentHash,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        if (block.timestamp > deadline) revert Expired();
        bytes32 structHash =
            keccak256(abi.encode(MANDATE_TYPEHASH, caseId, agent, maxAmountCents, consentHash, nonces[patient], deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
        // reject malleable high-s signatures
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) revert BadSignature();
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0) || signer != patient) revert BadSignature();
        nonces[patient]++;
        _open(caseId, patient, agent, maxAmountCents, consentHash, true);
    }

    function revokeMandate(bytes32 caseId) external {
        Mandate storage m = _mandates[caseId];
        if (m.patient == address(0)) revert NoMandate();
        if (msg.sender != m.patient) revert NotAuthorized();
        m.revoked = true;
        emit MandateRevoked(caseId);
    }

    function _open(bytes32 caseId, address patient, address agent, uint256 maxAmountCents, bytes32 consentHash, bool signed_)
        private
    {
        if (_mandates[caseId].patient != address(0)) revert MandateExists();
        if (agent == address(0)) revert ZeroAgent();
        _mandates[caseId] = Mandate(patient, agent, maxAmountCents, consentHash, uint64(block.timestamp), signed_, false);
        emit MandateOpened(caseId, patient, agent, maxAmountCents, consentHash, signed_);
    }

    // ---------------------------------------------------------------- log

    /// @notice Append one hashed entry. Only the mandated agent or the patient may write.
    function appendLog(bytes32 caseId, bytes32 entryHash) external returns (bytes32 head) {
        Mandate storage m = _mandates[caseId];
        if (m.patient == address(0)) revert NoMandate();
        if (msg.sender != m.agent && msg.sender != m.patient) revert NotAuthorized();
        head = keccak256(abi.encodePacked(heads[caseId], entryHash));
        heads[caseId] = head;
        uint256 index = logCounts[caseId]++;
        emit LogAppended(caseId, index, entryHash, head);
    }

    // ---------------------------------------------------------------- deal

    /// @notice The agent records the agreed deal. Reverts above the patient's mandate.
    function recordDeal(bytes32 caseId, uint256 amountCents, bytes32 transcriptRoot, string calldata settlementRef) external {
        Mandate storage m = _mandates[caseId];
        if (m.patient == address(0)) revert NoMandate();
        if (m.revoked) revert MandateIsRevoked();
        if (msg.sender != m.agent) revert NotAuthorized();
        if (amountCents > m.maxAmountCents) revert OverMandate(amountCents, m.maxAmountCents);
        if (_deals[caseId].recordedAt != 0) revert DealExists();
        _deals[caseId] =
            Deal(amountCents, transcriptRoot, heads[caseId], logCounts[caseId], settlementRef, uint64(block.timestamp));
        emit DealRecorded(caseId, amountCents, transcriptRoot, heads[caseId], settlementRef);
    }

    // ---------------------------------------------------------------- views

    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("AdvocateLedger"), keccak256("1"), block.chainid, address(this))
        );
    }

    function getMandate(bytes32 caseId) external view returns (Mandate memory) {
        return _mandates[caseId];
    }

    function getDeal(bytes32 caseId) external view returns (Deal memory) {
        return _deals[caseId];
    }

    function getHead(bytes32 caseId) external view returns (bytes32 head, uint256 count) {
        return (heads[caseId], logCounts[caseId]);
    }
}

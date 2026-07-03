// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title VectorMeritRegistry
/// @notice Auxiliary on-chain merit/eligibility cache for Vector on Mantle.
///         Complements the canonical ERC-8004 Identity + Reputation Registries
///         (identity 0x8004A818BFB912233c491871b3d84c89A494BD9e, reputation
///         0x8004B663056A597Dffe9eCcC1965A193B7388713) — NOT itself ERC-8004.
///         Stores a single latest score per agent so routers/firewalls can gate
///         eligibility in one SLOAD without querying the canonical registry.
/// @dev    Score range: integer 0..100 (matches ERC-8004 feedback value,
///         valueDecimals=0). Only the designated attestor may write; owner can
///         rotate the attestor via a 2-step propose/accept flow.
contract VectorMeritRegistry is Ownable, Pausable {
    // ── Types ───────────────────────────────────────────────────────────────

    /// @notice On-chain record of an agent's latest attested merit score.
    /// @param score         Integer merit score 0..100 (matches ERC-8004 feedback value, valueDecimals=0).
    /// @param evidenceHash  keccak256 of the off-chain evidence bundle anchoring the score.
    /// @param timestamp     Block timestamp when the attestation was recorded.
    /// @param nonce         Strictly increasing attestation counter per agentId (1-based; 0 = never attested).
    struct ScoreRecord {
        uint16 score;
        bytes32 evidenceHash;
        uint64 timestamp;
        uint64 nonce;
    }

    // ── Constants ───────────────────────────────────────────────────────────

    /// @notice Maximum allowed score value (integer 0..100, matching ERC-8004 valueDecimals=0).
    uint16 public constant MAX_SCORE = 100;

    // ── State ───────────────────────────────────────────────────────────────
    address public attestor;
    address public pendingAttestor;
    mapping(uint256 agentId => ScoreRecord) private _records;

    // ── Events ──────────────────────────────────────────────────────────────

    /// @notice Emitted when a new attestor is proposed by the owner.
    /// @param currentAttestor  The current attestor being replaced.
    /// @param proposedAttestor The newly proposed attestor awaiting acceptance.
    event AttestorProposed(address indexed currentAttestor, address indexed proposedAttestor);

    /// @notice Emitted when the active attestor changes (on construction or after accept).
    /// @param previousAttestor The old attestor address (address(0) on construction).
    /// @param newAttestor      The new active attestor address.
    event AttestorChanged(address indexed previousAttestor, address indexed newAttestor);

    /// @notice Emitted when a score is attested for an agent.
    /// @param agentId       The unique agent identifier.
    /// @param score         The attested integer score (0..100).
    /// @param evidenceHash  keccak256 of the off-chain evidence bundle.
    /// @param nonce         The attestation counter for this agent after this write.
    /// @param timestamp     The block timestamp of this attestation.
    event ScoreAttested(uint256 indexed agentId, uint16 score, bytes32 evidenceHash, uint64 nonce, uint64 timestamp);

    // ── Errors ──────────────────────────────────────────────────────────────

    /// @notice Caller is not the designated attestor.
    error NotAttestor();

    /// @notice Score exceeds MAX_SCORE (100).
    /// @param score The invalid score that was provided.
    error ScoreOutOfRange(uint16 score);

    /// @notice A zero address was provided where a nonzero address is required.
    error ZeroAddress();

    /// @notice The provided agentId is zero, which is not a valid agent identifier.
    error ZeroAgentId();

    /// @notice The evidence hash is bytes32(0), which is not valid evidence.
    error EmptyEvidence();

    /// @notice The owner and attestor addresses must be distinct.
    error OwnerIsAttestor();

    /// @notice Caller is not the pending attestor (2-step rotation).
    error NotPendingAttestor();

    /// @notice Renouncing ownership is disabled for safety.
    error RenounceDisabled();

    // ── Constructor ─────────────────────────────────────────────────────────

    /// @param initialOwner    Address that will own the contract (can propose attestor rotation).
    /// @param initialAttestor Address authorized to call attestScore. Must differ from initialOwner.
    constructor(address initialOwner, address initialAttestor) Ownable(initialOwner) {
        if (initialAttestor == address(0)) revert ZeroAddress();
        if (initialOwner == initialAttestor) revert OwnerIsAttestor();
        attestor = initialAttestor;
        emit AttestorChanged(address(0), initialAttestor);
    }

    // ── Modifiers ───────────────────────────────────────────────────────────
    modifier onlyAttestor() {
        if (msg.sender != attestor) revert NotAttestor();
        _;
    }

    // ── Writes ──────────────────────────────────────────────────────────────

    /// @notice Attest an AI-computed score for an agent. THE on-chain AI function.
    /// @param agentId        Unique agent identifier (must be nonzero).
    /// @param score          Merit score, integer 0..100 (matches ERC-8004 feedback value, valueDecimals=0).
    /// @param evidenceHash   keccak256 hash of off-chain evidence bundle (must be nonzero).
    function attestScore(uint256 agentId, uint16 score, bytes32 evidenceHash) external onlyAttestor whenNotPaused {
        if (agentId == 0) revert ZeroAgentId();
        if (evidenceHash == bytes32(0)) revert EmptyEvidence();
        if (score > MAX_SCORE) revert ScoreOutOfRange(score);

        ScoreRecord storage r = _records[agentId];
        uint64 newNonce = r.nonce + 1; // first attestation: 0 + 1 = 1
        uint64 ts = uint64(block.timestamp);

        r.score = score;
        r.evidenceHash = evidenceHash;
        r.timestamp = ts;
        r.nonce = newNonce;

        emit ScoreAttested(agentId, score, evidenceHash, newNonce, ts);
    }

    /// @notice Propose a new attestor. Only owner. The proposed address must call
    ///         `acceptAttestor()` to complete the rotation (2-step for safety).
    /// @param newAttestor New attestor address (must not be zero or the owner).
    function proposeAttestor(address newAttestor) external onlyOwner {
        if (newAttestor == address(0)) revert ZeroAddress();
        if (newAttestor == owner()) revert OwnerIsAttestor();
        emit AttestorProposed(attestor, newAttestor);
        pendingAttestor = newAttestor;
    }

    /// @notice Accept the pending attestor role. Only the pending attestor may call.
    function acceptAttestor() external {
        if (msg.sender != pendingAttestor) revert NotPendingAttestor();
        address old = attestor;
        attestor = pendingAttestor;
        delete pendingAttestor;
        emit AttestorChanged(old, msg.sender);
    }

    /// @notice Pause attestScore writes. Only owner.
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Unpause attestScore writes. Only owner.
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Disabled — ownership must not be renounced for safety.
    function renounceOwnership() public override onlyOwner {
        revert RenounceDisabled();
    }

    // ── Views ───────────────────────────────────────────────────────────────

    /// @notice Latest score record for an agent.
    /// @return score         The attested score (0 if never attested).
    /// @return evidenceHash  Evidence hash (bytes32(0) if never attested).
    /// @return timestamp     Block timestamp of last attestation (0 if never).
    /// @return nonce         Attestation count for this agent (0 if never).
    /// @return exists        True iff at least one attestation exists.
    function latestScore(uint256 agentId)
        external
        view
        returns (uint16 score, bytes32 evidenceHash, uint64 timestamp, uint64 nonce, bool exists)
    {
        ScoreRecord storage r = _records[agentId];
        return (r.score, r.evidenceHash, r.timestamp, r.nonce, r.nonce > 0);
    }

    /// @notice Capital-routing eligibility gate.
    /// @param agentId   The agent to check.
    /// @param minScore  Minimum score threshold (integer 0..100).
    /// @return True iff the agent has been attested AND its latest score >= minScore.
    function isEligible(uint256 agentId, uint16 minScore) external view returns (bool) {
        ScoreRecord storage r = _records[agentId];
        return r.nonce > 0 && r.score >= minScore;
    }
}

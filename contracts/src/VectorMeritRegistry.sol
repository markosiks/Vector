// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title VectorMeritRegistry
/// @notice On-chain anchor for AI-computed AgentScore attestations on Mantle.
///         Part of the Vector merit layer: bounded-execution referee + reputation scoring
///         + reputation-weighted capital routing. Off-chain AI computes a score per agent;
///         the authorized attestor publishes it here; routers/firewalls read eligibility.
/// @dev    Score range 0..1000 (representing 0.0..100.0 with one decimal).
///         Only the designated attestor may write; owner can rotate the attestor.
contract VectorMeritRegistry is Ownable {
    // ── Types ───────────────────────────────────────────────────────────────
    struct ScoreRecord {
        uint16 score; // 0..1000
        bytes32 evidenceHash;
        uint64 timestamp;
        uint64 nonce; // strictly increasing per agentId
    }

    // ── Constants ───────────────────────────────────────────────────────────
    uint16 public constant MAX_SCORE = 1000;

    // ── State ───────────────────────────────────────────────────────────────
    address public attestor;
    mapping(uint256 agentId => ScoreRecord) private _records;

    // ── Events ──────────────────────────────────────────────────────────────
    event AttestorChanged(address indexed previousAttestor, address indexed newAttestor);
    event ScoreAttested(uint256 indexed agentId, uint16 score, bytes32 evidenceHash, uint64 nonce, uint64 timestamp);

    // ── Errors ──────────────────────────────────────────────────────────────
    error NotAttestor();
    error ScoreOutOfRange(uint16 score);
    error ZeroAddress();

    // ── Constructor ─────────────────────────────────────────────────────────
    /// @param initialOwner  Address that will own the contract (can rotate attestor).
    /// @param initialAttestor  Address authorized to call attestScore.
    constructor(address initialOwner, address initialAttestor) Ownable(initialOwner) {
        if (initialAttestor == address(0)) revert ZeroAddress();
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
    /// @param agentId        Unique agent identifier.
    /// @param score          Merit score 0..1000 (0.0..100.0 with one decimal).
    /// @param evidenceHash   keccak256 hash of off-chain evidence bundle.
    function attestScore(uint256 agentId, uint16 score, bytes32 evidenceHash) external onlyAttestor {
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

    /// @notice Rotate the authorized attestor. Only owner.
    /// @param newAttestor  New attestor address (must not be zero).
    function setAttestor(address newAttestor) external onlyOwner {
        if (newAttestor == address(0)) revert ZeroAddress();
        address old = attestor;
        attestor = newAttestor;
        emit AttestorChanged(old, newAttestor);
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
    /// @return True iff the agent has been attested AND its latest score >= minScore.
    function isEligible(uint256 agentId, uint16 minScore) external view returns (bool) {
        ScoreRecord storage r = _records[agentId];
        return r.nonce > 0 && r.score >= minScore;
    }
}

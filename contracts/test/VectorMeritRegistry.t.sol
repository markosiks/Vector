// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {VectorMeritRegistry} from "../src/VectorMeritRegistry.sol";

contract VectorMeritRegistryTest is Test {
    VectorMeritRegistry public registry;

    address owner = address(0xA1);
    address attestor = address(0xA2);
    address nobody = address(0xA3);

    event ScoreAttested(uint256 indexed agentId, uint16 score, bytes32 evidenceHash, uint64 nonce, uint64 timestamp);
    event AttestorChanged(address indexed previousAttestor, address indexed newAttestor);
    event AttestorProposed(address indexed currentAttestor, address indexed proposedAttestor);

    function setUp() public {
        vm.prank(owner);
        registry = new VectorMeritRegistry(owner, attestor);
    }

    // ── Happy path ──────────────────────────────────────────────────────────

    function test_attestScore_happyPath() public {
        bytes32 evidence = keccak256("evidence-1");
        uint256 agentId = 42;

        vm.warp(1_700_000_000);
        vm.prank(attestor);
        vm.expectEmit(true, false, false, true);
        emit ScoreAttested(agentId, 74, evidence, 1, 1_700_000_000);
        registry.attestScore(agentId, 74, evidence);

        (uint16 score, bytes32 evHash, uint64 ts, uint64 nonce, bool exists) = registry.latestScore(agentId);
        assertEq(score, 74);
        assertEq(evHash, evidence);
        assertEq(ts, 1_700_000_000);
        assertEq(nonce, 1);
        assertTrue(exists);
    }

    // ── Access control ──────────────────────────────────────────────────────

    function test_attestScore_revert_nonAttestor() public {
        vm.prank(nobody);
        vm.expectRevert(VectorMeritRegistry.NotAttestor.selector);
        registry.attestScore(1, 50, keccak256("ev"));
    }

    function test_attestScore_revert_ownerIsNotAttestor() public {
        vm.prank(owner);
        vm.expectRevert(VectorMeritRegistry.NotAttestor.selector);
        registry.attestScore(1, 50, keccak256("ev"));
    }

    // ── Score range (0..100) ────────────────────────────────────────────────

    function test_attestScore_boundary_100_ok() public {
        vm.prank(attestor);
        registry.attestScore(1, 100, keccak256("ev"));
        (uint16 s,,,,) = registry.latestScore(1);
        assertEq(s, 100);
    }

    function test_attestScore_boundary_0_ok() public {
        vm.prank(attestor);
        registry.attestScore(1, 0, keccak256("ev"));
        (uint16 s,,,, bool exists) = registry.latestScore(1);
        assertEq(s, 0);
        assertTrue(exists);
    }

    function test_attestScore_revert_101() public {
        vm.prank(attestor);
        vm.expectRevert(abi.encodeWithSelector(VectorMeritRegistry.ScoreOutOfRange.selector, uint16(101)));
        registry.attestScore(1, 101, keccak256("ev"));
    }

    function test_attestScore_revert_maxUint16() public {
        vm.prank(attestor);
        vm.expectRevert(abi.encodeWithSelector(VectorMeritRegistry.ScoreOutOfRange.selector, type(uint16).max));
        registry.attestScore(1, type(uint16).max, keccak256("ev"));
    }

    // ── Input validation: agentId=0, evidenceHash=0 ─────────────────────────

    function test_attestScore_revert_zeroAgentId() public {
        vm.prank(attestor);
        vm.expectRevert(VectorMeritRegistry.ZeroAgentId.selector);
        registry.attestScore(0, 50, keccak256("ev"));
    }

    function test_attestScore_revert_emptyEvidence() public {
        vm.prank(attestor);
        vm.expectRevert(VectorMeritRegistry.EmptyEvidence.selector);
        registry.attestScore(1, 50, bytes32(0));
    }

    // ── Eligibility (0..100 scale) ──────────────────────────────────────────

    function test_isEligible_true_atThreshold() public {
        vm.prank(attestor);
        registry.attestScore(1, 70, keccak256("ev"));
        assertTrue(registry.isEligible(1, 70));
    }

    function test_isEligible_false_belowThreshold() public {
        vm.prank(attestor);
        registry.attestScore(1, 69, keccak256("ev"));
        assertFalse(registry.isEligible(1, 70));
    }

    function test_isEligible_true_aboveThreshold() public {
        vm.prank(attestor);
        registry.attestScore(1, 80, keccak256("ev"));
        assertTrue(registry.isEligible(1, 70));
    }

    // ── Unknown agent ───────────────────────────────────────────────────────

    function test_unknownAgent_existsFalse() public view {
        (uint16 s, bytes32 ev, uint64 ts, uint64 nonce, bool exists) = registry.latestScore(999);
        assertEq(s, 0);
        assertEq(ev, bytes32(0));
        assertEq(ts, 0);
        assertEq(nonce, 0);
        assertFalse(exists);
    }

    function test_unknownAgent_isEligibleFalse() public view {
        assertFalse(registry.isEligible(999, 0));
    }

    // ── Nonce increments ────────────────────────────────────────────────────

    function test_nonce_increments() public {
        vm.startPrank(attestor);
        registry.attestScore(1, 10, keccak256("a"));
        registry.attestScore(1, 20, keccak256("b"));
        registry.attestScore(1, 30, keccak256("c"));
        vm.stopPrank();

        (uint16 s,,, uint64 nonce,) = registry.latestScore(1);
        assertEq(s, 30);
        assertEq(nonce, 3);
    }

    // ── Multi-agent isolation ───────────────────────────────────────────────

    function test_multiAgent_isolation() public {
        bytes32 ev1 = keccak256("ev1");
        bytes32 ev2 = keccak256("ev2");

        vm.startPrank(attestor);
        registry.attestScore(1, 80, ev1);
        registry.attestScore(2, 40, ev2);
        vm.stopPrank();

        (uint16 s1,,,, bool e1) = registry.latestScore(1);
        (uint16 s2,,,, bool e2) = registry.latestScore(2);
        assertEq(s1, 80);
        assertEq(s2, 40);
        assertTrue(e1);
        assertTrue(e2);
        assertTrue(registry.isEligible(1, 70));
        assertFalse(registry.isEligible(2, 70));
    }

    // ── Constructor ─────────────────────────────────────────────────────────

    function test_constructor_emitsAttestorChanged() public {
        vm.expectEmit(true, true, false, false);
        emit AttestorChanged(address(0), attestor);
        new VectorMeritRegistry(owner, attestor);
    }

    function test_constructor_revert_zeroAttestor() public {
        vm.expectRevert(VectorMeritRegistry.ZeroAddress.selector);
        new VectorMeritRegistry(owner, address(0));
    }

    function test_constructor_revert_ownerEqualsAttestor() public {
        vm.expectRevert(VectorMeritRegistry.OwnerIsAttestor.selector);
        new VectorMeritRegistry(owner, owner);
    }

    // ── Attestor rotation (2-step propose/accept) ───────────────────────────

    function test_proposeAcceptAttestor_happyPath() public {
        address newAttestor = address(0xB1);

        // Propose
        vm.prank(owner);
        vm.expectEmit(true, true, false, false);
        emit AttestorProposed(attestor, newAttestor);
        registry.proposeAttestor(newAttestor);
        assertEq(registry.pendingAttestor(), newAttestor);

        // Accept
        vm.prank(newAttestor);
        vm.expectEmit(true, true, false, false);
        emit AttestorChanged(attestor, newAttestor);
        registry.acceptAttestor();
        assertEq(registry.attestor(), newAttestor);
        assertEq(registry.pendingAttestor(), address(0));

        // New attestor can write
        vm.prank(newAttestor);
        registry.attestScore(1, 50, keccak256("ev"));
        (uint16 s,,,,) = registry.latestScore(1);
        assertEq(s, 50);
    }

    function test_proposeAttestor_oldAttestorLosesAccess() public {
        address newAttestor = address(0xB1);

        vm.prank(owner);
        registry.proposeAttestor(newAttestor);

        vm.prank(newAttestor);
        registry.acceptAttestor();

        // Old attestor loses access
        vm.prank(attestor);
        vm.expectRevert(VectorMeritRegistry.NotAttestor.selector);
        registry.attestScore(1, 50, keccak256("ev"));
    }

    function test_proposeAttestor_revert_nonOwner() public {
        vm.prank(nobody);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", nobody));
        registry.proposeAttestor(address(0xB1));
    }

    function test_proposeAttestor_revert_zeroAddress() public {
        vm.prank(owner);
        vm.expectRevert(VectorMeritRegistry.ZeroAddress.selector);
        registry.proposeAttestor(address(0));
    }

    function test_proposeAttestor_revert_ownerIsAttestor() public {
        vm.prank(owner);
        vm.expectRevert(VectorMeritRegistry.OwnerIsAttestor.selector);
        registry.proposeAttestor(owner);
    }

    function test_acceptAttestor_revert_notPending() public {
        vm.prank(nobody);
        vm.expectRevert(VectorMeritRegistry.NotPendingAttestor.selector);
        registry.acceptAttestor();
    }

    function test_acceptAttestor_revert_noPendingSet() public {
        // No proposal made — pendingAttestor is address(0), any nonzero sender reverts
        vm.prank(attestor);
        vm.expectRevert(VectorMeritRegistry.NotPendingAttestor.selector);
        registry.acceptAttestor();
    }

    // ── Pause / unpause ─────────────────────────────────────────────────────

    function test_pause_blocksAttestScore() public {
        vm.prank(owner);
        registry.pause();

        vm.prank(attestor);
        vm.expectRevert(abi.encodeWithSignature("EnforcedPause()"));
        registry.attestScore(1, 50, keccak256("ev"));
    }

    function test_unpause_restoresAttestScore() public {
        vm.prank(owner);
        registry.pause();

        vm.prank(owner);
        registry.unpause();

        vm.prank(attestor);
        registry.attestScore(1, 50, keccak256("ev"));
        (uint16 s,,,,) = registry.latestScore(1);
        assertEq(s, 50);
    }

    function test_pause_revert_nonOwner() public {
        vm.prank(nobody);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", nobody));
        registry.pause();
    }

    function test_unpause_revert_nonOwner() public {
        vm.prank(owner);
        registry.pause();

        vm.prank(nobody);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", nobody));
        registry.unpause();
    }

    // ── renounceOwnership disabled ──────────────────────────────────────────

    function test_renounceOwnership_reverts() public {
        vm.prank(owner);
        vm.expectRevert(VectorMeritRegistry.RenounceDisabled.selector);
        registry.renounceOwnership();
    }

    // ── transferOwnership works ─────────────────────────────────────────────

    function test_transferOwnership_works() public {
        address newOwner = address(0xC1);

        vm.prank(owner);
        registry.transferOwnership(newOwner);
        assertEq(registry.owner(), newOwner);

        // New owner can pause
        vm.prank(newOwner);
        registry.pause();
    }

    // ── Fuzz: score range (0..100) ──────────────────────────────────────────

    function testFuzz_attestScore_validRange(uint16 score) public {
        if (score > 100) {
            vm.prank(attestor);
            vm.expectRevert(abi.encodeWithSelector(VectorMeritRegistry.ScoreOutOfRange.selector, score));
            registry.attestScore(1, score, keccak256("ev"));
        } else {
            vm.prank(attestor);
            registry.attestScore(1, score, keccak256("ev"));
            (uint16 stored,,,,) = registry.latestScore(1);
            assertEq(stored, score);
        }
    }

    // ── Fuzz: isEligible monotonicity ───────────────────────────────────────

    function testFuzz_isEligible_monotonicity(uint16 score, uint16 minScore) public {
        score = uint16(bound(score, 0, 100));

        vm.prank(attestor);
        registry.attestScore(1, score, keccak256("ev"));

        bool eligible = registry.isEligible(1, minScore);

        if (score >= minScore) {
            assertTrue(eligible, "should be eligible when score >= minScore");
        } else {
            assertFalse(eligible, "should not be eligible when score < minScore");
        }
    }
}

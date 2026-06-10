// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {VectorMeritRegistry} from "../src/VectorMeritRegistry.sol";

contract VectorMeritRegistryTest is Test {
    VectorMeritRegistry public registry;

    address owner = address(0xA1);
    address attestor = address(0xA2);
    address nobody = address(0xA3);

    event ScoreAttested(uint256 indexed agentId, uint16 score, bytes32 evidenceHash, uint64 nonce, uint64 timestamp);
    event AttestorChanged(address indexed previousAttestor, address indexed newAttestor);

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
        emit ScoreAttested(agentId, 735, evidence, 1, 1_700_000_000);
        registry.attestScore(agentId, 735, evidence);

        (uint16 score, bytes32 evHash, uint64 ts, uint64 nonce, bool exists) = registry.latestScore(agentId);
        assertEq(score, 735);
        assertEq(evHash, evidence);
        assertEq(ts, 1_700_000_000);
        assertEq(nonce, 1);
        assertTrue(exists);
    }

    // ── Access control ──────────────────────────────────────────────────────

    function test_attestScore_revert_nonAttestor() public {
        vm.prank(nobody);
        vm.expectRevert(VectorMeritRegistry.NotAttestor.selector);
        registry.attestScore(1, 500, bytes32(0));
    }

    function test_attestScore_revert_ownerIsNotAttestor() public {
        vm.prank(owner);
        vm.expectRevert(VectorMeritRegistry.NotAttestor.selector);
        registry.attestScore(1, 500, bytes32(0));
    }

    // ── Score range ─────────────────────────────────────────────────────────

    function test_attestScore_boundary_1000_ok() public {
        vm.prank(attestor);
        registry.attestScore(1, 1000, bytes32(0));
        (uint16 s,,,,) = registry.latestScore(1);
        assertEq(s, 1000);
    }

    function test_attestScore_boundary_0_ok() public {
        vm.prank(attestor);
        registry.attestScore(1, 0, bytes32(0));
        (uint16 s,,,, bool exists) = registry.latestScore(1);
        assertEq(s, 0);
        assertTrue(exists);
    }

    function test_attestScore_revert_1001() public {
        vm.prank(attestor);
        vm.expectRevert(abi.encodeWithSelector(VectorMeritRegistry.ScoreOutOfRange.selector, uint16(1001)));
        registry.attestScore(1, 1001, bytes32(0));
    }

    function test_attestScore_revert_maxUint16() public {
        vm.prank(attestor);
        vm.expectRevert(abi.encodeWithSelector(VectorMeritRegistry.ScoreOutOfRange.selector, type(uint16).max));
        registry.attestScore(1, type(uint16).max, bytes32(0));
    }

    // ── Eligibility ─────────────────────────────────────────────────────────

    function test_isEligible_true_atThreshold() public {
        vm.prank(attestor);
        registry.attestScore(1, 700, bytes32(0));
        assertTrue(registry.isEligible(1, 700));
    }

    function test_isEligible_false_belowThreshold() public {
        vm.prank(attestor);
        registry.attestScore(1, 699, bytes32(0));
        assertFalse(registry.isEligible(1, 700));
    }

    function test_isEligible_true_aboveThreshold() public {
        vm.prank(attestor);
        registry.attestScore(1, 800, bytes32(0));
        assertTrue(registry.isEligible(1, 700));
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
        registry.attestScore(1, 100, keccak256("a"));
        registry.attestScore(1, 200, keccak256("b"));
        registry.attestScore(1, 300, keccak256("c"));
        vm.stopPrank();

        (uint16 s,,, uint64 nonce,) = registry.latestScore(1);
        assertEq(s, 300);
        assertEq(nonce, 3);
    }

    // ── Attestor rotation ───────────────────────────────────────────────────

    function test_setAttestor_byOwner() public {
        address newAttestor = address(0xB1);

        vm.prank(owner);
        vm.expectEmit(true, true, false, false);
        emit AttestorChanged(attestor, newAttestor);
        registry.setAttestor(newAttestor);

        assertEq(registry.attestor(), newAttestor);

        // new attestor can write
        vm.prank(newAttestor);
        registry.attestScore(1, 500, bytes32(0));
        (uint16 s,,,,) = registry.latestScore(1);
        assertEq(s, 500);
    }

    function test_setAttestor_oldAttestorLosesAccess() public {
        address newAttestor = address(0xB1);

        vm.prank(owner);
        registry.setAttestor(newAttestor);

        vm.prank(attestor); // old attestor
        vm.expectRevert(VectorMeritRegistry.NotAttestor.selector);
        registry.attestScore(1, 500, bytes32(0));
    }

    function test_setAttestor_revert_nonOwner() public {
        vm.prank(nobody);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", nobody));
        registry.setAttestor(address(0xB1));
    }

    function test_setAttestor_revert_zeroAddress() public {
        vm.prank(owner);
        vm.expectRevert(VectorMeritRegistry.ZeroAddress.selector);
        registry.setAttestor(address(0));
    }

    function test_constructor_revert_zeroAttestor() public {
        vm.expectRevert(VectorMeritRegistry.ZeroAddress.selector);
        new VectorMeritRegistry(owner, address(0));
    }

    // ── Fuzz: score range ───────────────────────────────────────────────────

    function testFuzz_attestScore_validRange(uint16 score) public {
        if (score > 1000) {
            vm.prank(attestor);
            vm.expectRevert(abi.encodeWithSelector(VectorMeritRegistry.ScoreOutOfRange.selector, score));
            registry.attestScore(1, score, bytes32(0));
        } else {
            vm.prank(attestor);
            registry.attestScore(1, score, bytes32(0));
            (uint16 stored,,,,) = registry.latestScore(1);
            assertEq(stored, score);
        }
    }

    // ── Fuzz: isEligible monotonicity ───────────────────────────────────────

    function testFuzz_isEligible_monotonicity(uint16 score, uint16 minScore) public {
        score = uint16(bound(score, 0, 1000));

        vm.prank(attestor);
        registry.attestScore(1, score, bytes32(0));

        bool eligible = registry.isEligible(1, minScore);

        if (score >= minScore) {
            assertTrue(eligible, "should be eligible when score >= minScore");
        } else {
            assertFalse(eligible, "should not be eligible when score < minScore");
        }
    }
}

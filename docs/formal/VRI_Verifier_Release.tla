------------------------------- MODULE VRI_Verifier_Release -------------------------------
EXTENDS Naturals, Sequences, TLC

(***************************************************************************)
(* Release hardening model for verifier acceptance semantics.              *)
(***************************************************************************)

CONSTANTS ComplianceMin, ComplianceMax

VARIABLES
  audio_hash,
  watermark_state,
  watermark_payload,
  signature_valid,
  metadata_consistent,
  protocol_valid,
  compliance_level,
  nonce_seen,
  timestamp_valid,
  ledger_valid,
  trust_level,
  accepted,
  replay_enabled,
  ambiguous_field

WatermarkStates == {"present", "missing", "degraded", "not_applicable"}
TrustLevels == {"HIGH", "PARTIAL", "LOW"}
ComplianceDomain == ComplianceMin..ComplianceMax

TypeOK ==
  /\ audio_hash \in {"bound", "tampered", "missing"}
  /\ watermark_state \in WatermarkStates
  /\ watermark_payload \in {"bound", "tampered", "missing"}
  /\ signature_valid \in BOOLEAN
  /\ metadata_consistent \in BOOLEAN
  /\ protocol_valid \in BOOLEAN
  /\ compliance_level \in ComplianceDomain
  /\ nonce_seen \in BOOLEAN
  /\ timestamp_valid \in BOOLEAN
  /\ ledger_valid \in BOOLEAN
  /\ trust_level \in TrustLevels
  /\ accepted \in BOOLEAN
  /\ replay_enabled \in BOOLEAN
  /\ ambiguous_field \in BOOLEAN

StrictAccept ==
  /\ protocol_valid
  /\ ~ambiguous_field
  /\ signature_valid
  /\ metadata_consistent
  /\ audio_hash = "bound"
  /\ watermark_payload = "bound"
  /\ IF compliance_level >= 2 THEN watermark_state = "present" ELSE TRUE
  /\ timestamp_valid
  /\ IF replay_enabled THEN ~nonce_seen ELSE TRUE

TrustMap ==
  trust_level =
    IF ~protocol_valid \/ ~signature_valid \/ ~metadata_consistent THEN "LOW"
    ELSE IF watermark_state = "present" THEN "HIGH"
    ELSE "PARTIAL"

Init ==
  /\ audio_hash = "bound"
  /\ watermark_state = "present"
  /\ watermark_payload = "bound"
  /\ signature_valid = TRUE
  /\ metadata_consistent = TRUE
  /\ protocol_valid = TRUE
  /\ compliance_level = 2
  /\ nonce_seen = FALSE
  /\ timestamp_valid = TRUE
  /\ ledger_valid = FALSE
  /\ replay_enabled = TRUE
  /\ ambiguous_field = FALSE
  /\ accepted = FALSE
  /\ trust_level = "LOW"

GenerateProof ==
  /\ protocol_valid' = TRUE
  /\ metadata_consistent' = TRUE
  /\ signature_valid' = TRUE
  /\ audio_hash' = "bound"
  /\ watermark_payload' = "bound"
  /\ watermark_state' = "present"
  /\ timestamp_valid' = TRUE
  /\ nonce_seen' = FALSE
  /\ ledger_valid' \in BOOLEAN
  /\ compliance_level' \in ComplianceDomain
  /\ replay_enabled' = replay_enabled
  /\ ambiguous_field' = FALSE
  /\ accepted' = FALSE
  /\ trust_level' = "LOW"

VerifyProof ==
  /\ accepted' = StrictAccept
  /\ trust_level' =
       IF ~protocol_valid \/ ~signature_valid \/ ~metadata_consistent THEN "LOW"
       ELSE IF watermark_state = "present" THEN "HIGH"
       ELSE "PARTIAL"
  /\ UNCHANGED <<audio_hash, watermark_state, watermark_payload, signature_valid,
                 metadata_consistent, protocol_valid, compliance_level, nonce_seen,
                 timestamp_valid, ledger_valid, replay_enabled, ambiguous_field>>

ReplayAttack ==
  /\ replay_enabled
  /\ nonce_seen' = TRUE
  /\ UNCHANGED <<audio_hash, watermark_state, watermark_payload, signature_valid,
                 metadata_consistent, protocol_valid, compliance_level,
                 timestamp_valid, ledger_valid, trust_level, accepted,
                 replay_enabled, ambiguous_field>>

TamperProof ==
  /\ audio_hash' \in {"tampered", "missing"}
  /\ metadata_consistent' = FALSE
  /\ protocol_valid' = FALSE
  /\ signature_valid' = FALSE
  /\ ambiguous_field' \in BOOLEAN
  /\ UNCHANGED <<watermark_state, watermark_payload, compliance_level, nonce_seen,
                 timestamp_valid, ledger_valid, trust_level, accepted,
                 replay_enabled>>

MissingWatermark ==
  /\ compliance_level >= 2
  /\ watermark_state' \in {"missing", "degraded", "not_applicable"}
  /\ UNCHANGED <<audio_hash, watermark_payload, signature_valid, metadata_consistent,
                 protocol_valid, compliance_level, nonce_seen, timestamp_valid,
                 ledger_valid, trust_level, accepted, replay_enabled, ambiguous_field>>

InvalidSignature ==
  /\ signature_valid' = FALSE
  /\ UNCHANGED <<audio_hash, watermark_state, watermark_payload, metadata_consistent,
                 protocol_valid, compliance_level, nonce_seen, timestamp_valid,
                 ledger_valid, trust_level, accepted, replay_enabled, ambiguous_field>>

Next ==
  GenerateProof
  \/ VerifyProof
  \/ ReplayAttack
  \/ TamperProof
  \/ MissingWatermark
  \/ InvalidSignature

Spec == Init /\ [][Next]_<<audio_hash, watermark_state, watermark_payload, signature_valid,
                      metadata_consistent, protocol_valid, compliance_level, nonce_seen,
                      timestamp_valid, ledger_valid, trust_level, accepted,
                      replay_enabled, ambiguous_field>>

(***************************************************************************)
(* Invariants required for release closure                                  *)
(***************************************************************************)

InvSoundness == accepted => StrictAccept

InvFailClosed == ambiguous_field => ~accepted

InvWatermarkEnforcement == (compliance_level >= 2 /\ accepted) => watermark_state = "present"

InvSignatureRequired == accepted => signature_valid

InvNoLedgerOverride == (~signature_valid /\ ledger_valid) => ~accepted

InvDeterministicTrust ==
  trust_level =
    IF ~protocol_valid \/ ~signature_valid \/ ~metadata_consistent THEN "LOW"
    ELSE IF watermark_state = "present" THEN "HIGH"
    ELSE "PARTIAL"

InvReplayProtection == (replay_enabled /\ nonce_seen) => ~accepted

InvAll ==
  /\ TypeOK
  /\ InvSoundness
  /\ InvFailClosed
  /\ InvWatermarkEnforcement
  /\ InvSignatureRequired
  /\ InvNoLedgerOverride
  /\ InvDeterministicTrust
  /\ InvReplayProtection

=============================================================================

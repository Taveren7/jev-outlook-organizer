import {CONFIG} from './config';
import { parseClassification, type Classification } from './taxonomy';

// Provisional policy values, not measured accuracy guarantees.
export const POLICY = Object.freeze({
  choiceProbability: CONFIG.routing.choiceProbability,
  choiceConfidence: CONFIG.routing.choiceConfidence,
  securityReview: CONFIG.routing.securityHold,
  securityUncertain: 0.2,
  needsOwner: 0.7,
  needsOwnerNow: 0.8,
  noOwner: 0.2,
  archiveProbability: 0.95,
  archiveConfidence: 0.95,
  archiveSecurityMax: 0.05,
});
export type Disposition = 'security_review' | 'manual_review' | 'now' | 'action' | 'fyi' | 'archive_candidate' | 'none';
export interface Proposal {
  mode: 'observe';
  disposition: Disposition;
  proposedCategories: string[];
  reasons: string[];
  keepInInbox: true;
  mailboxWrites: 0;
}
function proposal(disposition: Disposition, reasons: string[], proposedCategories: string[] = []): Proposal {
  return { mode: 'observe', disposition, proposedCategories, reasons, keepInInbox: true, mailboxWrites: 0 };
}

export function decide(input: unknown, inputLimitations: string[] = []): Proposal {
  let c: Classification;
  try { c = parseClassification(input); }
  catch { return proposal('manual_review', ['Invalid or incomplete model output.']); }
  if (c.security_risk.noul >= POLICY.securityReview) {
    return proposal('security_review', ['Security review takes priority over all other classifications.'], ['JEV-SECURITY-REVIEW']);
  }
  if (inputLimitations.length) return proposal('manual_review', inputLimitations);
  if (c.security_risk.noul >= POLICY.securityUncertain) return proposal('manual_review', ['Security risk is unresolved.']);
  const choices: Array<{ confidence: number; choice: string; probabilities: Readonly<Record<string, number>> }> = [c.attention, c.type, c.action];
  if (choices.some(a => a.confidence < POLICY.choiceConfidence || a.probabilities[a.choice]! < POLICY.choiceProbability)) {
    return proposal('manual_review', ['At least one choice is uncertain; propose no categories.']);
  }
  const metadata = [`JEV-TYPE:${c.type.choice}`, `JEV-ACTION:${c.action.choice}`];
  if (c.needs_owner.noul >= POLICY.needsOwner) {
    if (['reference', 'archive'].includes(c.action.choice) || ['informational', 'none'].includes(c.attention.choice)) {
      return proposal('manual_review', ['Needs owner conflicts with the attention or action classification.']);
    }
    if (c.attention.choice === 'now' && c.needs_owner.noul < POLICY.needsOwnerNow) {
      return proposal('manual_review', ['Immediate attention needs stronger evidence that the mailbox owner must act.']);
    }
    const disposition = c.attention.choice === 'now' ? 'now' : 'action';
    return proposal(disposition, ['Clear request for the mailbox owner to act.'], [disposition === 'now' ? 'JEV-NOW' : 'JEV-ACTION', ...metadata]);
  }
  if (c.needs_owner.noul > POLICY.noOwner) return proposal('manual_review', ['Whether the mailbox owner needs to act is uncertain.']);
  if (['now', 'soon'].includes(c.attention.choice) || !['reference', 'archive'].includes(c.action.choice)) {
    return proposal('manual_review', ['Attention or action conflicts with low Needs owner.']);
  }
  if (c.attention.choice === 'informational') return proposal('fyi', ['Informational with no task for the mailbox owner.'], ['JEV-FYI', ...metadata]);
  if (c.action.choice === 'archive' && c.action.probabilities.archive >= POLICY.archiveProbability && c.action.confidence >= POLICY.archiveConfidence && c.attention.probabilities.none >= POLICY.archiveProbability && c.attention.confidence >= POLICY.archiveConfidence && c.security_risk.noul <= POLICY.archiveSecurityMax) {
    return proposal('archive_candidate', ['High-certainty filing candidate; remains in Inbox for review.'], ['JEV-ARCHIVE-CANDIDATE', ...metadata]);
  }
  return proposal('none', ['No immediate task; leave the message as it is.']);
}

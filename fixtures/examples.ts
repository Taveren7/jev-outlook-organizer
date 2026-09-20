import type { ChoiceResponse } from '@typesafe-ai/sdk';
import { ATTENTION, TYPE, ACTION, type Classification } from '../src/taxonomy';

// These hand-authored distributions exercise policy; they are NOT Jev predictions.
function certain<T extends Record<string, string>>(criteria: T, selected: keyof T & string): ChoiceResponse<T> {
  return { type: 'choice', choice: selected, confidence: 0.99, probabilities: Object.fromEntries(Object.keys(criteria).map(key => [key, key === selected ? 0.99 : 0.01 / (Object.keys(criteria).length - 1)])) as ChoiceResponse<T>['probabilities'] };
}
export function sample(attention: keyof typeof ATTENTION, type: keyof typeof TYPE, action: keyof typeof ACTION, needsOwner: number, securityRisk = 0.01): Classification {
  return {
    attention: certain(ATTENTION, attention), type: certain(TYPE, type), action: certain(ACTION, action),
    needs_owner: { type: 'noul', noul: needsOwner }, security_risk: { type: 'noul', noul: securityRisk },
  };
}
const uncertain = sample('soon', 'supply_chain', 'review_investigate', 0.6);
export const EXAMPLES = [
  { name: 'Customer needs an immediate answer', classification: sample('now', 'customer_sales', 'reply', 0.98) },
  { name: 'Please order a replacement machine filter', classification: sample('soon', 'internal_maintenance', 'order_buy', 0.97) },
  { name: 'Internal request to reconcile customer invoices', classification: sample('soon', 'customer_accounting', 'review_investigate', 0.96) },
  { name: 'Routine shipment confirmation without attachments', classification: sample('informational', 'pack_invoice_confirmation', 'reference', 0.04) },
  { name: 'Industry promotion', classification: sample('none', 'newsletter_marketing', 'archive', 0.01) },
  { name: 'Suspicious credential request', classification: sample('none', 'it_systems', 'archive', 0.01, 0.94) },
  { name: 'Unclear who should follow up', classification: uncertain },
] as const;

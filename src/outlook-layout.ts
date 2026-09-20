import {CONFIG} from './config';
export const TYPE_NAMES:Record<string,string>=Object.fromEntries(Object.entries(CONFIG.types).map(([key,v])=>[key,v.folder]));
export const ATTENTION_LABELS=CONFIG.attention;
export const ACTION_NAMES=Object.fromEntries(Object.entries(CONFIG.actions).map(([key,v])=>[key,v.name])) as {[K in keyof typeof CONFIG.actions]:string};
export const REVIEW_LABELS={needsReview:CONFIG.review.needsReview.name,securityReview:CONFIG.review.securityReview.name};

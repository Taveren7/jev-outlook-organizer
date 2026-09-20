import {test} from 'node:test';import assert from 'node:assert/strict';
import {CONFIG,validateConfig} from '../src/config';import {buildQuestions,parseClassification} from '../src/taxonomy';import {sample} from '../fixtures/examples';
test('custom Type keys, descriptions, folders and labels validate without source edits',()=>{
 const config=structuredClone(CONFIG);config.types={projects:{description:'Project updates and delivery work.',folder:'My Projects',color:'preset4',routine:false},receipts:{description:'Purchase receipts.',folder:'Purchase Records',color:'preset7',routine:true}};config.attention.now.name='Urgent';config.review.needsReview.name='Check This';
 assert.equal(validateConfig(config).types.projects?.folder,'My Projects');
 const questions=buildQuestions(Object.fromEntries(Object.entries(config.types).map(([k,v])=>[k,v.description])));assert.ok(questions.type);
 const answer={...sample('soon','other','reply',.9),type:{type:'choice',choice:'projects',confidence:.95,probabilities:{projects:.95,receipts:.05}}};assert.equal(parseClassification(answer,{projects:'Project work',receipts:'Receipts'}).type.choice,'projects');assert.throws(()=>parseClassification(answer));
});
test('invalid or colliding configuration fails before setup or deployment',()=>{
 const cases=[(c:any)=>c.routing.fileTruncatedMessage=true,(c:any)=>c.types.other.folder=c.attention.now.name,(c:any)=>c.types.other.folder='Inbox',(c:any)=>c.types.other.folder='Nested/Folder',(c:any)=>c.types.other.color='red',(c:any)=>c.timeZone='Unknown/Zone',(c:any)=>c.dailyLimit=0,(c:any)=>c.routing.securityHold=NaN,(c:any)=>c.types.other.description='',(c:any)=>c.actions.reply=undefined,(c:any)=>c.types={one:c.types.other},(c:any)=>c.types.constructor=c.types.other];
 for(const mutate of cases){const c=structuredClone(CONFIG);mutate(c);assert.throws(()=>validateConfig(c));}
});

test('optional action indicator validates names, colors and probability without changing legacy profiles',()=>{
 const legacy=structuredClone(CONFIG);delete legacy.actionIndicator;const fingerprint=JSON.stringify(legacy);
 assert.equal(JSON.stringify(validateConfig(legacy)),fingerprint);assert.equal(legacy.actionIndicator,undefined);
 for(const indicator of [null,{}, {name:'Needs Me',color:'preset0',threshold:NaN},{name:'Needs Me',color:'preset0',threshold:1.01},{name:'Needs Me',color:'red',threshold:.9},{name:CONFIG.actions.reply.name,color:'preset0',threshold:.9}])assert.throws(()=>validateConfig({...CONFIG,actionIndicator:indicator}));
 const custom={...CONFIG,actionIndicator:{name:'My Action',color:'preset2',threshold:.95}};assert.equal(validateConfig(custom).actionIndicator?.threshold,.95);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {messageSummary,outlookWebLink} from '../src/production/message-summary';

test('message summaries expose only bounded plain-text display fields',()=>{
  const result=messageSummary({subject:'  Order\n update\u202e ',from:{emailAddress:{name:'Buyer',address:'buyer@example.test'}},bodyPreview:'x'.repeat(400),body:{content:'private full body'},attachments:[{}],access_token:'private'});
  assert.deepEqual(result,{subject:'Order update',senderName:'Buyer',senderAddress:'buyer@example.test',snippet:'x'.repeat(255)});
  assert.deepEqual(messageSummary(null),{subject:'',senderName:'',senderAddress:'',snippet:''});
  assert.equal(messageSummary({subject:'x'.repeat(800)}).subject.length,500);
});
test('Outlook links accept only exact Microsoft work-mail origins',()=>{
  for(const host of ['outlook.office.com','outlook.office365.com','outlook.cloud.microsoft']){
    const link=`https://${host}/owa/?ItemID=synthetic%2Bitem&viewmodel=ReadMessageItem`;
    assert.equal(outlookWebLink(link),link);
  }
  for(const link of ['https://outlook.live.com/mail/','https://outlook.office.com.evil.test/','http://outlook.office.com/','https://user:pass@outlook.office.com/','https://outlook.office.com:444/','javascript:alert(1)',null])assert.throws(()=>outlookWebLink(link));
});

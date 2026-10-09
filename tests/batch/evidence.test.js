import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyEvidence } from '../../batch/evidence.js';

test('evidence requires a real quote from the correct context or an observed and readable web source', async () => {
  const quote = 'This is the actual source statement.';
  const contexts = { documents: { first: { text: quote }, second: { text: 'A different lecture, with different facts.' } } };
  const questions = [{ slot: '1', contextId: 'first' }];
  const decision = evidence => ({ slot: '1', status: 'candidate', sourceUrls: ['https://source.example/'], evidence });
  const evidence = { kind: 'context', contextId: 'first', quote };
  assert.equal((await verifyEvidence([decision(evidence)], questions, contexts))[0].status, 'candidate');
  for (const wrong of [undefined, { ...evidence, contextId: 'second' }, { ...evidence, quote: 'An invented quote of sufficient length.' }]) {
    assert.equal((await verifyEvidence([decision(wrong)], questions, contexts))[0].status, 'needs_review');
  }
  let reads = 0;
  const readSource = async () => { reads++; return quote; };
  const web = { kind: 'web', url: 'https://source.example/', quote };
  assert.ok((await verifyEvidence([decision(web), decision(web)], questions, contexts, { readSource })).every(d => d.evidenceVerified));
  assert.equal(reads, 1);
  assert.equal((await verifyEvidence([decision({ ...web, url: 'https://invented.example/' })], questions, contexts, { readSource }))[0].status, 'needs_review');
  assert.equal(reads, 1, 'unobserved URLs must not be read');
  assert.equal((await verifyEvidence([decision(web)], questions, contexts, { readSource: async () => { throw new Error(); } }))[0].status, 'needs_review');
});

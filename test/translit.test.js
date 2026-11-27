import { test } from 'node:test';
import assert from 'node:assert/strict';
import { devanagariToRoman as t } from '../public/translit.js';

test('Hindi speech becomes readable Hinglish in English letters', () => {
  assert.equal(t('मेरा हिसाब बताओ'), 'mera hisab batao');
  assert.equal(t('२८ दिसंबर को पचास मेहमान'), '28 disambar ko pachas mehman');
  assert.equal(t('कितना बैलेंस बाकी है'), 'kitna bailens baki hai');
  assert.equal(t('बुकिंग कैंसल कर दो'), 'buking kainsal kar do');
  assert.equal(t('रूम नंबर एक सौ एक'), 'rum nambar ek sau ek');
  assert.equal(t('पाँच हज़ार रुपये'), 'panch hazar rupye');
});

test('English text and mixed text are left alone', () => {
  assert.equal(t('book 5 rooms'), 'book 5 rooms');
  assert.equal(t('28 December को booking'), '28 December ko booking');
  assert.equal(t(''), '');
});

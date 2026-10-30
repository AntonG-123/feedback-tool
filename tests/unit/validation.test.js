import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateFeedback } from '../../shared/validation.js';

const v = (text, attachments, element) => validateFeedback({ text, attachments, element });

function blocked(text, expectQuestions = [], attachments) {
  const r = v(text, attachments);
  assert.equal(r.canSubmit, false, `expected "${text}" to be blocked, got ${JSON.stringify(r)}`);
  assert.ok(r.questions.length > 0, `expected questions for "${text}"`);
  for (const q of expectQuestions) {
    assert.ok(r.questions.some((x) => x.toLowerCase().includes(q.toLowerCase())), `"${text}": expected question containing "${q}", got ${JSON.stringify(r.questions)}`);
  }
  return r;
}
function allowed(text, attachments, element) {
  const r = v(text, attachments, element);
  assert.equal(r.canSubmit, true, `expected "${text}" to be allowed, got ${JSON.stringify(r)}`);
  assert.equal(r.questions.length, 0);
  return r;
}

test('specification examples', () => {
  blocked('Just adjust it.', ['What exactly would you like me to adjust?']);
  blocked('Please replace the image.', ["What don't you like about the current image?", 'What image would you like to use instead?']);
  const r = blocked('Change the image.', ["Please attach the image you'd like to use to this comment."]);
  assert.deepEqual(r.requiredAttachments, ['image']);
  blocked('I would rephrase this.', ['What specifically bothers you about the wording?', 'How would you rephrase it?']);
});

test('category-specific follow-up questions', () => {
  blocked('Make it bigger.', ['enlarged']);
  blocked('Make it smaller', ['smaller']);
  blocked('Change the color.', ['Which color']);
  blocked('Move this.', ['Where should']);
  blocked('Fix this button.', ['What is wrong with the button?', 'clicked']);
  blocked('This link is broken', ['Where should the link lead']);
  blocked('The spacing is off', ['increased or reduced']);
  blocked('Change the font', ['font, size or weight']);
  blocked('Add text', ['What exactly should be added']);
  blocked("I don't like this", ["What don't you like", 'prefer instead']);
  blocked('Change the layout', ['How should the layout look']);
  blocked('Update the headline', []);
  blocked('There is a typo', ['correct spelling']);
});

test('empty, very short and padded input stays blocked', () => {
  blocked('', ['What would you like to change']);
  blocked('ok');
  blocked('hmm');
  blocked('asdf qwer zxcv');
  // Typing more characters must not unlock a vague request.
  blocked('Make it bigger please please please now quickly thanks', ['enlarged']);
  blocked('Just adjust it. Just adjust it. Just adjust it.', ['adjust']);
  blocked('Change the image now please thank you very much', ['attach']);
});

test('attachment-aware validation', () => {
  allowed('Change the image.', { images: 1 });
  allowed('Please replace the image.', { images: 1 });
  const r = v('Change the image', { images: 0 });
  assert.ok(r.questions.some((q) => /attach/i.test(q)));
  // An image element with a pronoun counts as image context.
  blocked('Replace this', ['instead'], undefined);
  const el = v('Replace this.', {}, { isImage: true, tag: 'img' });
  assert.equal(el.canSubmit, false);
  assert.ok(el.questions.some((q) => /image/i.test(q)));
  assert.equal(v('Replace this.', { images: 1 }, { isImage: true, tag: 'img' }).canSubmit, true);
  blocked('', [], { images: 1 });
});

test('specific actionable feedback is accepted', () => {
  allowed('Change the headline color to #1F6FEB');
  allowed('Change the color to dark blue');
  allowed('Make the logo 20% bigger');
  allowed('Make the heading bigger');
  allowed('Move this button to the right of the image');
  allowed('Replace the hero image with a photo of our team in the office');
  allowed("Change the headline to 'Websites that convert'");
  allowed('I would rephrase this to: We build fast websites for growing brands');
  allowed('The contact button does not work, nothing happens when I click it. It should open the contact form.');
  allowed('This link should go to /pricing');
  allowed('Remove this section');
  allowed('Looks great!');
  allowed('Increase the padding above the footer to 40px');
  allowed('The phone number in the footer is outdated, it should be +49 30 123456');
  allowed('Use the font Inter for all headings');
  allowed('Make the text bold');
  allowed('Add our phone number +49 30 123456 to the footer');
  allowed('Align the button center');
  allowed('Show the three cards side by side instead of stacked');
  allowed('The image is blurry, please use the high resolution version from our brand folder instead');
  allowed('The spacing between the cards is too tight, add about 24px');
});

test('structured result shape', () => {
  const r = v('Change the color.');
  for (const k of ['actionable', 'canSubmit', 'category', 'missing', 'questions', 'requiredAttachments', 'provider']) assert.ok(k in r, k);
  assert.equal(r.category, 'color');
  assert.deepEqual(r.missing, ['color_value']);
});

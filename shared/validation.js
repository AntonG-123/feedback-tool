// Adaptive feedback validation: decides whether a comment contains enough
// information for a designer/developer to act on, and generates follow-up
// questions specific to the detected intent.
//
// Pure ES module, shared by the browser (instant feedback while typing) and
// the server (authoritative check on submit). An optional LLM provider on the
// server can refine the result (server/validation/index.js).
//
// Model: each intent category has "slots" (pieces of information that must be
// present). A comment is actionable when every detected category has its
// slots filled, either by the text or by attachments. Adding characters never
// helps by itself; only the required information does.

const PRONOUN_ONLY = new Set(['it', 'this', 'that', 'these', 'those', 'them', 'here', 'there', 'something', 'stuff', 'thing', 'things', 'everything', 'all', 'one', 'bit', 'little', 'please', 'just', 'the', 'a', 'an', 'again', 'up', 'down', 'more', 'some', 'whole', 'part', 'element', 'area', 'section?']);

const SUBJECT_NOUNS = [
  'text', 'font', 'fonts', 'heading', 'headings', 'headline', 'title', 'subtitle', 'button', 'buttons', 'cta', 'logo', 'image', 'images', 'photo',
  'picture', 'icon', 'icons', 'section', 'hero', 'banner', 'card', 'cards', 'box', 'menu', 'nav', 'navigation', 'navbar', 'footer', 'header',
  'form', 'field', 'input', 'video', 'gallery', 'slider', 'carousel', 'spacing', 'padding', 'margin', 'gap', 'line', 'border', 'column',
  'columns', 'row', 'container', 'graphic', 'paragraph', 'label', 'link', 'links', 'arrow', 'map', 'table', 'list', 'item', 'items', 'badge',
  'avatar', 'quote', 'testimonial', 'price', 'pricing', 'copy', 'description', 'caption', 'illustration', 'thumbnail', 'background', 'block',
  'tagline', 'sidebar', 'popup', 'modal', 'dropdown', 'tab', 'tabs', 'checkbox', 'author', 'date', 'number', 'phone', 'address', 'email',
];

const COLOR_WORDS = 'red|blue|green|yellow|orange|purple|violet|pink|black|white|gr[ae]y|brown|beige|navy|teal|turquoise|gold|golden|silver|cyan|magenta|maroon|olive|lime|coral|salmon|mint|cream|ivory|indigo|lavender|charcoal|burgundy|transparent|sand|peach|aqua|crimson|khaki|primary|secondary|accent|brand';

const re = {
  quote: /["“”„«»]([^"“”„«»]{3,})["“”„«»]|(^|\s)'([^']{3,})'(\s|[.,!?]|$)|‘([^’]{3,})’/,
  colon: /:\s*\S+(\s+\S+)+/,
  url: /https?:\/\/\S+|\bwww\.\S+|\b[a-z0-9-]+\.(com|de|io|org|net|co|app|dev)\b(\/\S*)?|(^|\s)\/[a-z0-9-]+(\/[a-z0-9-]*)*/i,
  hex: /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\bpantone\b/i,
  colorName: new RegExp(`\\b(${COLOR_WORDS})(ish)?\\b`, 'i'),
  colorRelative: /\b(darker|lighter|brighter|duller|more (saturated|muted|vibrant|contrast)|less (saturated|bright|contrast)|higher contrast|same colou?r as|match(es|ing)? (the|our)|colou?r of the)\b/i,
  amount: /\b\d+(\.\d+)?\s*(px|%|pt|rem|em|vh|vw|x|times)\b|\b(twice|double|triple|half|slightly|a (little )?bit|a little|much|significantly|considerably|noticeably|way|a lot|same size as|as (big|large|small|wide|tall) as)\b|\bby \d+/i,
  direction: /\b(to|towards|on) the (left|right|top|bottom|center|centre|middle|side|end|start)\b|\b(above|below|under|beneath|underneath|next to|beside|besides|after|before|left of|right of|on top of|in front of|behind|between|into|inside|in the (header|footer|sidebar|nav|navigation|hero|top|bottom|menu|middle))\b|\b(center|centre|centred|centered|align(ed)? (left|right|center|centre)|left[- ]aligned|right[- ]aligned|(up|down|left|right) (by|a bit|slightly|\d+))\b|\b(to|into) (the )?(first|last|second|top|bottom)\b|\bmove (it |this )?(up|down|left|right)\b/i,
  problem: /\b(doesn'?t|does not|isn'?t|is not|won'?t|will not|can'?t|cannot|not)\s+(work|working|load|loading|open|opening|clickable|click|respond|responding|show|showing|display|displaying|appear|appearing|play|playing|scroll|submit|close|go|lead|link|visible|readable|aligned|centered|responsive)\b|\bnothing happens\b|\bbroken\b|\berror\b|\b40[0-9]\b|\b50[0-9]\b|\bcrash|\bfreez|\bwrong (link|page|url|address|number|date|price|email|image|name|text|year)\b|\b(goes|leads|redirects|links|points) to\b|\bopens\b|\bstuck\b|\boverlap|\bcut off\b|\bcropped\b|\bmisaligned\b|\btypo\b|\bmisspel|\boutdated\b|\bincorrect\b|\bout of date\b|\bdead link\b|\bunreadable\b|\bhard to read\b|\bflicker|\bjump(s|ing)?\b|\bslow\b|\boverflow/i,
  expectation: /\bshould\b|\bexpected\b|\bexpect\b|\binstead\b|\bneeds? to\b|\bmust\b|\bhas to\b|\bhave to\b|\bwant(ed)?( it)? to\b|\bwould like\b|\bsupposed to\b|\bought to\b|\bplease (make|let|link|open|send|show)\b/i,
  reason: /\bbecause\b|\bsince\b|\bas it\b|\bdue to\b|\btoo (\w+)|\b(blurry|blurred|pixelated|pixely|low[- ]?(res|resolution|quality)|grainy|dark|bright|outdated|old|generic|stock|boring|cheesy|irrelevant|wrong|off[- ]brand|unprofessional|cropped|distorted|stretched|small|tiny|huge|confusing|unclear|misleading|ugly|inconsistent|doesn'?t (fit|match|show|represent|convey)|not (relevant|sharp|clear|on brand))\b/i,
  newImage: /\b(with|to|by|for) (a|an|the|our|my|some|one of)\b.{3,}|\b(photo|image|picture|shot|illustration|graphic|video) (of|showing|with|from)\b.{3,}|\b(use|take|pick|choose|put)\b.{3,}\b(instead|from|image|photo|picture)\b|\binstead\b|\battached\b|\bfrom (the|our|my) (drive|folder|dropbox|website|media|gallery|shoot|library|brand)\b|https?:\/\//i,
  newText: /\b(should|could|must|to|will|would) (say|read|be|state|mention)\s+\S+|\b(change|replace|rename|rewrite|reword|update|correct|fix)\b.{0,60}\b(to|with|into|as)\s+["“„'‘]?\S+|\binstead of\b.{2,}|\b(say|write|use) ["“„'‘]/i,
  tone: /\b(shorter|longer|more (concise|formal|casual|friendly|professional|direct|specific|personal|engaging|inviting|precise|detailed)|less (formal|technical|salesy|wordy|aggressive|pushy)|simpler|clearer|in (german|english|french|spanish|italian|dutch)|translate|translated|spell(ed)? (correctly|out)|capitali[sz]ed?|all caps|title case|sentence case)\b/i,
  fontValue: /\b(bold|bolder|semi-?bold|light|lighter|thin|regular|medium|heavy|black|italic|normal|underlined?|uppercase|lowercase|capitali[sz]ed?|serif|sans[- ]serif|monospace|title case|all caps)\b|\b\d+\s*(px|pt|rem|em)\b|\bsame (font|style|size|typeface) as\b|\b(use|to|with|in)\s+(["“'‘]?[A-Z][a-zA-Z]+)|\b(font|typeface|family)\s+["“'‘]?[A-Z][a-zA-Z]+/,
  spacingDir: /\b(more|less|increase|decrease|reduce|tighter|looser|bigger|smaller|larger|add|remove|double|halve|too (much|little|big|small|tight|large|wide|narrow)|cramped|crowded|squeezed|no space)\b|\b\d+\s*px\b/i,
  layoutTarget: /\b(\d+|one|two|three|four|five|single) (columns?|rows?|cards?|items?)\b|\bside by side\b|\bstack(ed|ing)?\b|\bfull[- ]?width\b|\b(first|last|swap|before|after|above|below)\b|\bgrid (of|with)\b|\bcent(er|re)(ed)?\b|\bhorizontal(ly)?\b|\bvertical(ly)?\b|\bin a (row|line|grid|column)\b/i,
  linkTarget: /https?:\/\/|\bwww\.|(^|\s)\/[a-z0-9-]+|\b(should|must|needs? to|has to)\s+(go|link|point|lead|open|navigate|redirect)\b|\bto the .{3,}\bpage\b|\b(go|link|point|lead|open|navigate|redirect)(s)? to\b.{3,}/i,
  praise: /^(this )?(looks?|is|feels|seems)? ?(really |very |so )?(great|good|perfect|amazing|awesome|fine|nice|excellent|fantastic|beautiful|lovely|clean|solid)( job| work)?( here)?[\s!.]*$|^(love|like) (it|this)( a lot)?[\s!.]*$|^(perfect|great|nice|awesome|well done|approved?|lgtm|thumbs up|good job|great job|nice work|all good|looks good to me)[\s!.]*$/i,
};

const CAT = {
  image: /\b(image|images|photo|photos|picture|pictures|pic|pics|img|graphic|graphics|illustration|visual|banner|icon|logo|thumbnail|video|background image|hero image)\b/i,
  imageVerb: /\b(change|replace|swap|switch|update|exchange|new|different|another|other)\b/i,
  replaceVerb: /\b(replace|swap|exchange|switch out)\b/i,
  text: /\b(text|copy|copies|wording|words?|headline|heading|title|subtitle|tagline|paragraph|sentence|phrase|label|caption|description|button text|content|spelling|grammar|typo)\b|\b(rephrase|reword|rewrite|reformulate|rename|retitle|phrase|phrasing|word it)\b/i,
  rephrase: /\b(rephrase|reword|rewrite|reformulate|phrasing|word it|wording)\b/i,
  color: /\b(colou?rs?|colou?red|tint|shade|hue|darker|lighter|brighter)\b|\bbackground\b(?! image)/i,
  typo: /\b(font|fonts|typeface|typography|font[- ]?size|font[- ]?weight|bold|italic|underline|line[- ]?height|letter[- ]?spacing|kerning|uppercase|lowercase|capitali[sz]e)\b/i,
  size: /\b(bigger|larger|smaller|tinier|enlarge|shrink|increase|decrease|reduce|bump up|scale (up|down)|resize|wider|narrower|taller|thicker|thinner|too (big|small|large|tiny|huge|wide|narrow))\b|\bsize\b/i,
  move: /\b(move|shift|reposition|relocate|place|put|drag|push|align|aligned|alignment|position)\b/i,
  spacing: /\b(spacing|space|spaces|padding|margin|margins|gap|gaps|whitespace|white space|breathing room|cramped|crowded)\b/i,
  layout: /\b(layout|columns?|grid|stack(ed)?|side by side|full[- ]width|wrap|reorder|rearrange|arrangement|order of)\b/i,
  link: /\b(link|links|url|href|redirect|redirects)\b/i,
  functional: /\b(bug|broken|not working|doesn'?t work|does not work|fix|error|crash|glitch|issue|problem)\b/i,
  interactive: /\b(button|form|dropdown|menu|slider|carousel|popup|modal|submit|checkout|cart|search|filter|login|video|tab|accordion|toggle|field|input|checkbox)\b/i,
  add: /\b(add|adding|missing|include|insert|need (a|an|the|more|some)|there should be|put in|lacks?|lacking)\b/i,
  remove: /\b(remove|delete|get rid of|hide|drop|take out|take away|eliminate|strike)\b/i,
  dislike: /\b(don'?t like|do not like|dislike|hate|not (a )?fan|ugly|looks? (off|weird|strange|bad|wrong|odd|cheap)|not (good|great|nice|right|ideal)|meh|feels? off|not happy)\b/i,
  general: /\b(adjust|change|fix|improve|update|tweak|modify|edit|redo|rework|revise|refine|polish|optimi[sz]e|enhance|work on|look at|check|alter|better|correct|different|rethink|redesign)\b/i,
};

function subjectAfter(lower, verbRe) {
  const m = lower.match(new RegExp(verbRe.source + '\\s+(.{0,60})', 'i'));
  return m ? m[m.length - 1] : '';
}

function concreteSubject(lower) {
  for (const n of SUBJECT_NOUNS) if (new RegExp(`\\b${n}\\b`, 'i').test(lower)) return n;
  return null;
}

function onlyVague(fragment) {
  const words = (fragment.toLowerCase().match(/[a-z']+/g) || []).filter((w) => !['to', 'be', 'make', 'of', 'please', 'a', 'an'].includes(w));
  return words.length === 0 || words.every((w) => PRONOUN_ONLY.has(w));
}

function looksLikeWords(words) {
  if (!words.length) return false;
  const ok = words.filter((w) => /[aeiouyäöü]/i.test(w) && w.length < 20 && !/(.)\1\1/.test(w));
  return ok.length / words.length >= 0.6;
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * @param {{ text: string, attachments?: { images?: number, audio?: number }, element?: { tag?: string, isImage?: boolean, text?: string } }} input
 */
export function validateFeedback(input) {
  const text = String(input?.text || '').trim();
  const images = Number(input?.attachments?.images || 0);
  const el = input?.element || {};
  const result = (actionable, category, missing, questions, requiredAttachments = []) => ({
    actionable, canSubmit: actionable, category, missing, questions: questions.slice(0, 3), requiredAttachments, provider: 'rules',
  });

  if (!text) {
    if (images) return result(false, 'empty', ['description'], ['Please describe what should be done with the attached image.']);
    return result(false, 'empty', ['description'], ['What would you like to change here?']);
  }

  const lower = text.toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, ' ');
  const words = lower.match(/[a-zäöüß0-9#']+/g) || [];
  if (!looksLikeWords(words)) {
    return result(false, 'unclear', ['description'], ['Could you describe in words what should change here and how?']);
  }
  if (re.praise.test(lower)) return result(true, 'approval', [], []);

  const s = {
    quote: re.quote.test(text) || re.colon.test(text),
    url: re.url.test(lower),
    color: re.hex.test(lower) || re.colorName.test(lower) || re.colorRelative.test(lower),
    amount: re.amount.test(lower),
    direction: re.direction.test(lower),
    problem: re.problem.test(lower),
    expectation: re.expectation.test(lower),
    reason: re.reason.test(lower),
    newImage: re.newImage.test(lower),
    newText: re.newText.test(lower) || re.quote.test(text),
    tone: re.tone.test(lower),
    fontValue: re.fontValue.test(text),
    spacingDir: re.spacingDir.test(lower),
    layoutTarget: re.layoutTarget.test(lower),
    linkTarget: re.linkTarget.test(lower),
  };
  const subject = concreteSubject(lower);
  const imageContext = CAT.image.test(lower) || (el.isImage && /\b(this|it|that)\b/.test(lower));

  const issues = []; // { category, missing, question, attachment? }
  const found = [];
  const need = (category, missing, question, attachment) => issues.push({ category, missing, question, attachment });

  // --- removal: the anchored element is the target, nothing else needed
  if (CAT.remove.test(lower) && !CAT.add.test(lower)) found.push('remove');

  // --- image replacement
  if (imageContext && (CAT.imageVerb.test(lower) || CAT.dislike.test(lower)) && !CAT.size.test(lower) && !found.includes('remove')) {
    found.push('image');
    const hasNew = images > 0 || s.newImage || s.url;
    if (!hasNew) {
      if (CAT.replaceVerb.test(lower) || CAT.dislike.test(lower)) {
        if (!s.reason) need('image', 'reason', "What don't you like about the current image?");
        need('image', 'new_image', 'What image would you like to use instead?', 'image');
      } else {
        need('image', 'new_image', "Please attach the image you'd like to use to this comment.", 'image');
      }
    }
  }

  // --- colour
  if (CAT.color.test(lower) && !found.includes('image')) {
    found.push('color');
    if (!s.color) need('color', 'color_value', 'Which color should be used instead (e.g. a color name or a hex code like #1F6FEB)?');
  }

  // --- typography
  if (CAT.typo.test(lower)) {
    found.push('typography');
    const valueGiven = s.fontValue && !/^(change|update|adjust|fix) (the )?(font|typography|typeface)\.?$/.test(lower);
    if (!valueGiven && !s.amount && !s.quote) need('typography', 'font_value', 'Which font, size or weight should be used instead?');
  }

  // --- size
  if (CAT.size.test(lower) && !CAT.spacing.test(lower)) {
    found.push('size');
    const m = lower.match(CAT.size);
    const word = m ? m[0] : 'bigger';
    const smaller = /smaller|tinier|shrink|decrease|reduce|narrower|thinner|scale down|too (big|large|huge|wide)/.test(word);
    const subj = subject && !/^(text|copy)$/.test(subject) ? subject : subject;
    if (!subj && !imageContext) {
      need('size', 'subject', smaller
        ? 'What exactly should be made smaller — the text, an image, or the whole element?'
        : 'What exactly should be enlarged — the text, an image, or the whole element?');
    }
  }

  // --- spacing
  if (CAT.spacing.test(lower)) {
    found.push('spacing');
    if (!s.spacingDir && !s.amount) need('spacing', 'spacing_direction', 'Should the spacing be increased or reduced, and roughly by how much?');
  }

  // --- position
  if (CAT.move.test(lower) && !found.includes('spacing')) {
    found.push('position');
    if (!s.direction && !s.layoutTarget) {
      need('position', 'destination', /align/.test(lower)
        ? 'How should it be aligned — left, center or right?'
        : 'Where should this element be moved to (e.g. above the headline or to the right of the image)?');
    }
  }

  // --- layout
  if (CAT.layout.test(lower) && !found.includes('position')) {
    found.push('layout');
    if (!s.layoutTarget && !s.direction) need('layout', 'layout_target', 'How should the layout look instead (e.g. two columns, stacked or full width)?');
  }

  // --- links
  if (CAT.link.test(lower) && (s.problem || CAT.functional.test(lower) || CAT.general.test(lower))) {
    found.push('link');
    if (!s.linkTarget && !s.url) {
      if (!s.problem && !CAT.functional.test(lower)) need('link', 'problem', 'What is wrong with the link?');
      need('link', 'link_target', 'Where should the link lead instead?');
    }
  }

  // --- functional issues (buttons, forms, menus...)
  const interactive = lower.match(CAT.interactive);
  if (!found.includes('link') && (CAT.functional.test(lower) || (interactive && s.problem)) && !found.some((c) => ['color', 'typography', 'size', 'spacing', 'position', 'layout', 'image'].includes(c))) {
    found.push('functional');
    const thing = interactive ? interactive[0] : subject || 'element';
    const isClickable = /button|link|menu|tab|toggle|submit|cta|checkbox|dropdown/.test(thing);
    const symptomGiven = s.problem && !/^(fix|broken)\b/.test(lower.replace(/^(please|pls) /, '')) || s.problem && words.length > 4;
    if (!symptomGiven) need('functional', 'problem', `What is wrong with the ${thing}?`);
    if (!s.expectation && !s.linkTarget) {
      need('functional', 'expected_behaviour', isClickable ? `What should happen when the ${thing} is clicked?` : 'What should happen instead?');
    }
  }

  // --- text / copy
  if ((CAT.text.test(lower) || (CAT.general.test(lower) && /\b(say|says|written|wording)\b/.test(lower))) && !found.some((c) => ['typography', 'color', 'size', 'image', 'functional', 'link', 'remove'].includes(c))) {
    found.push('text');
    const typo = /\btypo|misspel|spelling|grammar\b/.test(lower);
    if (!(s.newText || s.quote || s.tone || (s.reason && s.expectation))) {
      if (CAT.rephrase.test(lower)) {
        need('text', 'reason', 'What specifically bothers you about the wording?');
        need('text', 'new_text', 'How would you rephrase it?');
      } else if (typo) {
        need('text', 'correction', 'Which word is wrong, and what is the correct spelling?');
      } else {
        need('text', 'new_text', `What should the new ${subject && /headline|heading|title|subtitle|tagline|label|caption|description|copy|paragraph/.test(subject) ? subject : 'text'} say?`);
      }
    }
  }

  // --- additions
  if (CAT.add.test(lower) && !found.some((c) => ['spacing', 'functional'].includes(c))) {
    found.push('add');
    const after = subjectAfter(lower, CAT.add);
    const generic = /^(some |a |an |the |more )?(text|content|stuff|something|things|info|information|image|picture|photo|button|section|link)?[.!]?$/.test(after.trim());
    const detail = s.quote || s.url || /\b(that says|saying|with the text|linking to|showing|which|that shows|about|for (the|our))\b/.test(lower) || (!generic && !onlyVague(after) && after.split(' ').filter(Boolean).length >= 2);
    if (!detail && !(images && /image|photo|picture|logo/.test(after))) {
      if (/image|picture|photo|logo/.test(after)) need('add', 'content', 'Which image should be added? Please attach it to this comment.', 'image');
      else need('add', 'content', 'What exactly should be added, and what should it say or contain?');
    }
  }

  // --- dislike without specifics
  if (CAT.dislike.test(lower) && !found.includes('image')) {
    found.push('dislike');
    if (!s.reason) need('dislike', 'reason', "What don't you like about it?");
    if (!s.expectation && !s.newText && !s.color && !s.direction && !s.tone) need('dislike', 'alternative', 'What would you prefer instead?');
  }

  // --- generic change verbs ("adjust it", "fix this", "improve the hero")
  if (!found.length && CAT.general.test(lower)) {
    found.push('general');
    const specific = s.color || s.amount || s.direction || s.newText || s.quote || s.tone || s.layoutTarget || s.url || (s.problem && s.expectation) || (s.reason && s.expectation);
    if (!specific) {
      const verb = (lower.match(CAT.general) || ['change'])[0];
      const objFrag = subjectAfter(lower, CAT.general);
      const subj = !onlyVague(objFrag) && subject ? `the ${subject}` : null;
      const Q = {
        adjust: subj ? `How exactly should ${subj} be adjusted?` : 'What exactly would you like me to adjust?',
        fix: subj ? `What is wrong with ${subj}, and what should it look like or do instead?` : 'What exactly needs to be fixed, and what should it look like or do instead?',
        improve: subj ? `What should be improved about ${subj}, and how?` : 'What should be improved, and how?',
        update: subj ? `What should ${subj} be updated to?` : 'What should be updated, and what should it be updated to?',
      };
      need('general', 'specifics', Q[verb] || (subj ? `How exactly should ${subj} be changed?` : `What exactly should be ${verb === 'look at' || verb === 'check' ? 'checked' : 'changed'}, and how?`));
    }
  }

  // --- nothing recognised: accept clear descriptive feedback, ask otherwise
  if (!found.length) {
    const longEnough = words.length >= 10 || (words.length >= 5 && (s.expectation || s.problem || s.quote || s.url || s.color));
    if (!longEnough) {
      if (/\?\s*$/.test(text) && words.length >= 4) return result(true, 'question', [], []);
      return result(false, 'unclear', ['description'], ['Could you describe what should change here and how it should look or work instead?']);
    }
    return result(true, 'general', [], []);
  }

  if (!issues.length) return result(true, found[0], [], []);
  const questions = [...new Set(issues.map((i) => i.question))];
  const att = [...new Set(issues.filter((i) => i.attachment).map((i) => i.attachment))];
  return result(false, issues[0].category, issues.map((i) => i.missing), questions.map(cap), att);
}

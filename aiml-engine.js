/* ============================================================================
   AIML Engine — a small, self-contained AIML 2.0-ish interpreter that runs
   entirely in the browser. No backend, no Pandorabots dependency.

   Supported: <pattern> wildcards * _ # $, pattern-side <set>NAME</set> word
   references, <that>/<topic> context matching, <srai>, <think>, <set>/<get>
   predicates, <random>, <condition> (all 3 li forms) with <loop/>, <map>
   (custom + built-in successor/predecessor), <formal>/<sentence>/<lowercase>
   /<uppercase>, <explode>, <first>/<rest>, <person>/<person2>/<gender>
   substitutions, <bot name>, <input>/<response> history, <id/>, basic
   <date>/<interval>, <button>/<link>/<carousel> rendered as real UI, and
   in-memory <learn>/<learnf>.

   Known simplifications (see chat for details): <sraix> cross-bot calls
   fall back to a message instead of calling another bot; <learn>/<learnf>
   categories don't persist across a page reload; <date>/<interval> jformat
   parsing covers the patterns this bot actually uses, not the full spec.
============================================================================ */

class AIMLEngine {
  constructor(basePath = '') {
    this.basePath = basePath;
    this.categories = [];       // {patternTokens, thatTokens, topic, template}
    this.sets = {};             // name -> Set of lowercase words
    this.maps = {};             // name -> Map of lowercase key -> value
    this.substitutions = {};    // name -> [[from,to], ...]
    this.properties = {};       // name -> value (lowercase keys)
    this.predicates = this._loadPredicates();
    this.inputHistory = [];     // most recent first
    this.responseHistory = [];  // most recent first
    this.srCount = 0;
    this.sessionId = this._loadOrCreateId();
  }

  // ---------------------------------------------------------------- loading

  async loadAll(manifest) {
    const fetchJSON = async (path) => {
      const res = await fetch(this.basePath + path);
      if (!res.ok) throw new Error('Failed to load ' + path);
      return JSON.parse(await res.text());
    };
    const fetchText = async (path) => {
      const res = await fetch(this.basePath + path);
      if (!res.ok) throw new Error('Failed to load ' + path);
      return await res.text();
    };

    // properties
    if (manifest.properties) {
      const arr = await fetchJSON(manifest.properties);
      arr.forEach(([k, v]) => { this.properties[k.toLowerCase()] = v; });
    }

    // sets
    for (const [name, path] of Object.entries(manifest.sets || {})) {
      const arr = await fetchJSON(path);
      this.sets[name.toLowerCase()] = new Set(
        arr.map(row => (Array.isArray(row) ? row[0] : row).toLowerCase())
      );
    }

    // maps
    for (const [name, path] of Object.entries(manifest.maps || {})) {
      const arr = await fetchJSON(path);
      const m = new Map();
      arr.forEach(([k, v]) => m.set(String(k).toLowerCase(), v));
      this.maps[name.toLowerCase()] = m;
    }

    // substitutions
    for (const [name, path] of Object.entries(manifest.substitutions || {})) {
      const arr = await fetchJSON(path);
      this.substitutions[name.toLowerCase()] = arr;
    }

    // aiml files
    for (const path of manifest.aiml || []) {
      const xmlText = await fetchText(path);
      this._parseAIMLText(xmlText);
    }
  }

  _parseAIMLText(xmlText) {
    const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
    const errorNode = doc.querySelector('parsererror');
    if (errorNode) {
      console.error('AIML parse error:', errorNode.textContent);
      return;
    }
    this._walkForCategories(doc.documentElement, '*');
  }

  _walkForCategories(node, currentTopic) {
    for (const child of Array.from(node.children)) {
      if (child.tagName === 'topic') {
        const topicName = child.getAttribute('name') || '*';
        this._walkForCategories(child, topicName);
      } else if (child.tagName === 'category') {
        this._registerCategory(child, currentTopic);
      } else {
        // aiml root, or unknown wrapper — recurse just in case
        this._walkForCategories(child, currentTopic);
      }
    }
  }

  _registerCategory(catNode, topic) {
    const patternNode = catNode.querySelector(':scope > pattern');
    const thatNode = catNode.querySelector(':scope > that');
    const templateNode = catNode.querySelector(':scope > template');
    const topicNode = catNode.querySelector(':scope > topic');
    if (!patternNode || !templateNode) return;

    this.categories.push({
      patternTokens: this._tokenizePatternNode(patternNode),
      thatTokens: thatNode ? this._tokenizePatternNode(thatNode) : [{ type: 'star' }],
      topic: topicNode ? this._tokenizeWords(topicNode.textContent) : this._tokenizeWords(topic),
      template: templateNode,
    });
  }

  // Turn a <pattern>/<that> element into tokens, honoring inline <set>NAME</set>
  _tokenizePatternNode(node) {
    const tokens = [];
    for (const child of node.childNodes) {
      if (child.nodeType === 3) { // text
        tokens.push(...this._tokenizeWords(child.textContent));
      } else if (child.nodeType === 1 && child.tagName === 'set') {
        tokens.push({ type: 'setref', name: child.textContent.trim().toLowerCase() });
      }
    }
    return tokens;
  }

  _tokenizeWords(str) {
    return (str || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(w => {
        if (w === '*') return { type: 'star' };
        if (w === '_') return { type: 'underscore' };
        if (w === '#') return { type: 'hash' };
        if (w.startsWith('$') && w.length > 1) return { type: 'word', value: w.slice(1).toUpperCase(), priority: true };
        return { type: 'word', value: w.toUpperCase() };
      });
  }

  // ---------------------------------------------------------------- matching

  // Score-based matcher with backtracking. Returns {category, stars, thatStars} or null.
  respond(userInput) {
    this.inputHistory.unshift(userInput);
    const inputWords = this._tokenizeInputWords(userInput);
    const lastThat = this.responseHistory[0] || '*';
    const thatWords = this._tokenizeInputWords(this._lastSentence(lastThat));
    const topic = this.predicates.get('topic') || '*';
    const topicWords = this._tokenizeInputWords(topic);

    const match = this._findBestMatch(inputWords, thatWords, topicWords);
    let output;
    if (!match) {
      output = "I don't have an answer for that yet.";
    } else {
      this._starsStack = [match.stars];
      try {
        output = this._evalNode(match.category.template, { stars: match.stars }).trim();
      } catch (e) {
        console.error(e);
        output = "Something went wrong processing that reply.";
      }
    }
    output = output.replace(/\s+/g, ' ').replace(/\s+([.,!?])/g, '$1').trim();
    this.responseHistory.unshift(output);
    this._savePredicates();
    return output;
  }

  _tokenizeInputWords(str) {
    return (str || '')
      .replace(/[.,!?;]+$/g, '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
  }

  _lastSentence(text) {
    const splitters = (this.properties['sentence-splitters'] || '.!?').split('');
    const re = new RegExp('[' + splitters.map(c => '\\' + c).join('') + ']');
    const parts = text.split(re).map(s => s.trim()).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : text;
  }

  _findBestMatch(inputWords, thatWords, topicWords) {
    let best = null;
    let bestScore = -1;
    for (const cat of this.categories) {
      const stars = [];
      const pScore = this._matchTokens(cat.patternTokens, inputWords, 0, 0, stars);
      if (pScore === null) continue;
      const thatStars = [];
      const tScore = this._matchTokens(cat.thatTokens, thatWords, 0, 0, thatStars);
      if (tScore === null) continue;
      const topicStars = [];
      const toScore = this._matchTokens(cat.topic, topicWords, 0, 0, topicStars);
      if (toScore === null) continue;
      const total = pScore * 100 + tScore * 10 + toScore;
      if (total > bestScore) {
        bestScore = total;
        best = { category: cat, stars, thatStars, topicStars };
      }
    }
    return best;
  }

  // Recursive backtracking matcher. Returns a numeric score, or null on failure.
  _matchTokens(tokens, words, ti, wi, stars) {
    if (ti >= tokens.length) return wi >= words.length ? 0 : null;
    const tok = tokens[ti];

    if (tok.type === 'word') {
      if (wi >= words.length) return null;
      if (words[wi].toUpperCase() !== tok.value) return null;
      const rest = this._matchTokens(tokens, words, ti + 1, wi + 1, stars);
      if (rest === null) return null;
      return rest + (tok.priority ? 5 : 3);
    }

    if (tok.type === 'setref') {
      if (wi >= words.length) return null;
      const set = this.sets[tok.name];
      const word = words[wi];
      const inSet = tok.name === 'number'
        ? /^\d+$/.test(word)
        : (set && set.has(word.toLowerCase()));
      if (!inSet) return null;
      const savedLen = stars.length;
      stars.push(word);
      const rest = this._matchTokens(tokens, words, ti + 1, wi + 1, stars);
      if (rest === null) { stars.length = savedLen; return null; }
      return rest + 2;
    }

    if (tok.type === 'hash' || tok.type === 'underscore' || tok.type === 'star') {
      // greedy-with-backtrack: try consuming as many words as possible, down to the minimum
      const minWords = tok.type === 'hash' || tok.type === 'star' ? 0 : 1;
      const weight = tok.type === 'hash' ? 1.5 : (tok.type === 'underscore' ? 1 : 0.5);
      for (let take = words.length - wi; take >= minWords; take--) {
        const savedLen = stars.length;
        const consumed = words.slice(wi, wi + take).join(' ');
        if (take > 0) stars.push(consumed);
        const rest = this._matchTokens(tokens, words, ti + 1, wi + take, stars);
        if (rest !== null) return rest + weight;
        if (take > 0) stars.length = savedLen;
      }
      return null;
    }

    return null;
  }

  // ---------------------------------------------------------------- template eval

  _evalNode(node, ctx) {
    let out = '';
    for (const child of node.childNodes) {
      out += this._evalChild(child, ctx);
    }
    return out;
  }

  _evalChildren(node, ctx) {
    let out = '';
    for (const child of node.childNodes) out += this._evalChild(child, ctx);
    return out;
  }

  _evalChild(node, ctx) {
    if (node.nodeType === 3) return node.textContent; // text
    if (node.nodeType !== 1) return '';
    const tag = node.tagName.toLowerCase();
    const handler = this._tagHandlers[tag];
    if (handler) return handler.call(this, node, ctx) || '';
    // unknown tag: just render children (safe default)
    return this._evalChildren(node, ctx);
  }

  get _tagHandlers() {
    return {
      star: (node, ctx) => {
        const idx = parseInt(node.getAttribute('index') || '1', 10) - 1;
        return ctx.stars[idx] || '';
      },
      think: (node, ctx) => { this._evalChildren(node, ctx); return ''; },
      break: () => ' ',
      delay: () => '',
      sr: (node, ctx) => ctx.stars[0] || '',

      set: (node, ctx) => {
        const name = (node.getAttribute('name') || '').toLowerCase();
        const value = this._evalChildren(node, ctx).trim();
        if (name) this.predicates.set(name, value);
        return value;
      },
      get: (node, ctx) => {
        const name = (node.getAttribute('name') || '').toLowerCase();
        if (!name) return this.predicates.get('topic') || this._defaultGet();
        return this.predicates.has(name) ? this.predicates.get(name) : this._defaultGet();
      },

      srai: (node, ctx) => {
        this.srCount++;
        if (this.srCount > 25) return '';
        const text = this._evalChildren(node, ctx).trim();
        const words = this._tokenizeInputWords(text);
        const lastThat = this.responseHistory[0] || '*';
        const thatWords = this._tokenizeInputWords(this._lastSentence(lastThat));
        const topic = this.predicates.get('topic') || '*';
        const topicWords = this._tokenizeInputWords(topic);
        const match = this._findBestMatch(words, thatWords, topicWords);
        if (!match) return '';
        const result = this._evalNode(match.category.template, { stars: match.stars });
        this.srCount--;
        return result;
      },

      sraix: (node, ctx) => {
        // Cross-bot calls can't work in a static, serverless build.
        const botName = node.querySelector('bot') ? node.querySelector('bot').getAttribute('name') : null;
        return `[cross-bot lookup to "${botName || 'another bot'}" isn't available in this static build]`;
      },

      random: (node, ctx) => {
        const lis = Array.from(node.children).filter(c => c.tagName === 'li');
        if (!lis.length) return '';
        const pick = lis[Math.floor(Math.random() * lis.length)];
        return this._evalChildren(pick, ctx);
      },

      condition: (node, ctx) => {
        const name = (node.getAttribute('name') || '').toLowerCase();
        let out = '';
        let guard = 0;
        while (guard++ < 2000) {
          const lis = Array.from(node.children).filter(c => c.tagName === 'li');
          const predVal = name ? (this.predicates.has(name) ? this.predicates.get(name) : this._defaultGet()) : '';
          let matchedLi = null;
          let fallback = null;
          for (const li of lis) {
            const valueChild = Array.from(li.children).find(c => c.tagName === 'value');
            let compareTo = null;
            if (li.hasAttribute('value')) compareTo = li.getAttribute('value');
            else if (valueChild) compareTo = this._evalChildren(valueChild, ctx).trim();
            if (compareTo === null) { fallback = fallback || li; continue; }
            if (compareTo.toLowerCase() === String(predVal).toLowerCase()) { matchedLi = li; break; }
          }
          const chosen = matchedLi || fallback;
          if (!chosen) break;
          for (const c of chosen.childNodes) {
            if (c.nodeType === 1 && c.tagName === 'value') continue; // comparison-only, not rendered
            out += this._evalChild(c, ctx);
          }
          const hasLoop = !!(chosen.querySelector && chosen.querySelector('loop'));
          if (!hasLoop) break;
        }
        return out;
      },
      loop: () => '',
      value: () => '', // handled by condition directly; avoid double-render if reached standalone

      map: (node, ctx) => {
        const name = (node.getAttribute('name') || '').toLowerCase();
        const key = this._evalChildren(node, ctx).trim();
        if (name === 'successor') {
          const n = parseInt(key, 10);
          return isNaN(n) ? this._defaultMap() : String(n + 1);
        }
        if (name === 'predecessor') {
          const n = parseInt(key, 10);
          return isNaN(n) ? this._defaultMap() : String(n - 1);
        }
        const m = this.maps[name];
        if (!m) return this._defaultMap();
        return m.has(key.toLowerCase()) ? m.get(key.toLowerCase()) : this._defaultMap();
      },

      bot: (node, ctx) => {
        const name = (node.getAttribute('name') || '').toLowerCase();
        return this.properties[name] !== undefined ? this.properties[name] : this._defaultProperty();
      },
      id: () => this.sessionId,
      program: () => 'a browser-based AIML interpreter',

      input: (node, ctx) => {
        const idx = parseInt(node.getAttribute('index') || '1', 10) - 1;
        return this.inputHistory[idx] || '';
      },
      response: (node, ctx) => {
        const idx = parseInt(node.getAttribute('index') || '1', 10) - 1;
        return this.responseHistory[idx] || '';
      },
      that: (node, ctx) => {
        const idx = parseInt(node.getAttribute('index') || '1', 10) - 1;
        return this.responseHistory[idx] || '';
      },

      formal: (node, ctx) => this._evalChildren(node, ctx)
        .replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()),
      sentence: (node, ctx) => {
        const s = this._evalChildren(node, ctx);
        return s.charAt(0).toUpperCase() + s.slice(1);
      },
      lowercase: (node, ctx) => this._evalChildren(node, ctx).toLowerCase(),
      uppercase: (node, ctx) => this._evalChildren(node, ctx).toUpperCase(),
      explode: (node, ctx) => this._evalChildren(node, ctx).split('').join(' '),
      first: (node, ctx) => this._evalChildren(node, ctx).trim().split(/\s+/)[0] || '',
      rest: (node, ctx) => this._evalChildren(node, ctx).trim().split(/\s+/).slice(1).join(' '),

      person: (node, ctx) => this._applySubstitution(this._evalChildren(node, ctx), 'person'),
      person2: (node, ctx) => this._applySubstitution(this._evalChildren(node, ctx), 'person2'),
      gender: (node, ctx) => this._applySubstitution(this._evalChildren(node, ctx), 'gender'),
      normalize: (node, ctx) => this._applySubstitution(this._evalChildren(node, ctx), 'normal'),
      denormalize: (node, ctx) => this._applySubstitution(this._evalChildren(node, ctx), 'denormal'),

      date: (node, ctx) => this._formatDate(new Date(), node.getAttribute('jformat')),
      interval: (node, ctx) => this._evalInterval(node, ctx),

      eval: (node, ctx) => this._evalChildren(node, ctx),

      learn: (node, ctx) => { this._learn(node, ctx); return ''; },
      learnf: (node, ctx) => { this._learn(node, ctx); return ''; },

      // Rich-content tags: rendered as inline markers, turned into real UI by the front end.
      button: (node, ctx) => this._renderButton(node, ctx),
      link: (node, ctx) => this._renderButton(node, ctx),
      carousel: (node, ctx) => this._renderCarousel(node, ctx),

      topic: () => '',
    };
  }

  _defaultGet() { return this.properties['default-get'] || 'unknown'; }
  _defaultProperty() { return this.properties['default-property'] || 'unknown'; }
  _defaultMap() { return this.properties['default-map'] || 'unknown'; }

  _applySubstitution(text, listName) {
    const list = this.substitutions[listName];
    if (!list) return text;
    let padded = ' ' + text + ' ';
    for (const [from, to] of list) padded = padded.split(from).join(to);
    return padded.trim();
  }

  _formatDate(d, jformat) {
    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    if (jformat && jformat.includes('MMMM')) {
      return `${months[d.getMonth()]} ${d.getDate()}`;
    }
    return d.toDateString();
  }

  _evalInterval(node, ctx) {
    const fromNode = node.querySelector('from');
    const toNode = node.querySelector('to');
    const style = (node.querySelector('style') ? this._evalChildren(node.querySelector('style'), ctx) : 'days').trim();
    const fromText = fromNode ? this._evalChildren(fromNode, ctx).trim() : '';
    const toText = toNode ? this._evalChildren(toNode, ctx).trim() : '';
    const year = new Date().getFullYear();
    const parseLoose = (s) => {
      let d = new Date(s);
      if (isNaN(d)) d = new Date(s + ', ' + year);
      if (isNaN(d)) d = new Date(s + ' ' + year);
      return d;
    };
    const from = parseLoose(fromText);
    const to = parseLoose(toText);
    if (isNaN(from) || isNaN(to)) return 'some';
    let diffMs = to - from;
    if (diffMs < 0 && !/\d{4}/.test(toText) && !/\d{4}/.test(fromText)) {
      // same-year month/day comparison rolled over — assume "to" is next year
      diffMs = new Date(to.getTime()); diffMs.setFullYear(diffMs.getFullYear() + 1); diffMs = diffMs - from;
    }
    const divisor = style === 'minutes' ? 60000 : style === 'seconds' ? 1000 : 86400000;
    return String(Math.abs(Math.round(diffMs / divisor)));
  }

  _learn(node, ctx) {
    const catNodes = Array.from(node.children).filter(c => c.tagName === 'category');
    for (const catNode of catNodes) {
      // Evaluate any <eval> nodes inside pattern/template with current stars first
      const clone = catNode.cloneNode(true);
      const evals = clone.querySelectorAll('eval');
      evals.forEach(ev => {
        const text = this._evalChildren(ev, ctx);
        ev.replaceWith(document.createTextNode(text));
      });
      this._registerCategory(clone, this.predicates.get('topic') || '*');
    }
  }

  _renderButton(node, ctx) {
    const textNode = node.querySelector('text');
    const urlNode = node.querySelector('url');
    const text = textNode ? this._evalChildren(textNode, ctx).trim() : this._evalChildren(node, ctx).trim();
    const url = urlNode ? this._evalChildren(urlNode, ctx).trim() : '#';
    return `[[BUTTON|${text}|${url}]]`;
  }

  _renderCarousel(node, ctx) {
    const cards = Array.from(node.children).filter(c => c.tagName === 'card').map(card => {
      const get = (tag) => {
        const el = card.querySelector(tag);
        return el ? this._evalChildren(el, ctx).trim() : '';
      };
      const btn = card.querySelector('button');
      let button = null;
      if (btn) {
        const t = btn.querySelector('text');
        const u = btn.querySelector('url');
        button = { text: t ? this._evalChildren(t, ctx).trim() : '', url: u ? this._evalChildren(u, ctx).trim() : '#' };
      }
      return { image: get('image'), title: get('title'), subtitle: get('subtitle'), button };
    });
    return `[[CAROUSEL|${encodeURIComponent(JSON.stringify(cards))}]]`;
  }

  // ---------------------------------------------------------------- predicates persistence

  _loadPredicates() {
    try {
      const raw = localStorage.getItem('aiml_predicates');
      if (raw) return new Map(Object.entries(JSON.parse(raw)));
    } catch (e) {}
    return new Map();
  }
  _savePredicates() {
    try {
      localStorage.setItem('aiml_predicates', JSON.stringify(Object.fromEntries(this.predicates)));
    } catch (e) {}
  }
  _loadOrCreateId() {
    try {
      let id = localStorage.getItem('aiml_session_id');
      if (!id) {
        id = 'user-' + Math.random().toString(36).slice(2, 10);
        localStorage.setItem('aiml_session_id', id);
      }
      return id;
    } catch (e) {
      return 'user-anon';
    }
  }
}

if (typeof module !== 'undefined') module.exports = { AIMLEngine };

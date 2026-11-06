// Display and print preferences (per browser).
import * as store from '../store.js';
import { ctx, emit } from './ctx.js';

const DEFAULTS = {
  font: 'sans', size: 17, line: 1.75, page: 'page', theme: 'auto',
  showCount: true, spellcheck: false,
  paper: 'A4', orientation: 'portrait', margin: 'normal', pageNumbers: true,
};

export const settings = { ...DEFAULTS, ...store.readPref('settings', {}) };

const PAPER = { A4: ['210mm', '297mm'], B5: ['182mm', '257mm'], Letter: ['8.5in', '11in'] };
const MARGIN = { narrow: '12mm', normal: '20mm', wide: '30mm' };

let printStyle = null;

export function applySettings() {
  const r = document.documentElement;
  r.dataset.font = settings.font;
  r.dataset.page = settings.page;
  if (settings.theme === 'auto') delete r.dataset.theme; else r.dataset.theme = settings.theme;
  r.style.setProperty('--fs', settings.size + 'px');
  r.style.setProperty('--lh', String(settings.line));
  if (ctx.view) ctx.view.dom.spellcheck = !!settings.spellcheck;
  if (!printStyle) { printStyle = document.createElement('style'); document.head.append(printStyle); }
  const num = settings.pageNumbers ? '@bottom-center{content:counter(page) " / " counter(pages);font-size:9pt;color:#666}' : '';
  const [w, h] = PAPER[settings.paper] || PAPER.A4;
  const size = settings.orientation === 'landscape' ? `${h} ${w}` : `${w} ${h}`;
  printStyle.textContent = `@page{size:${size};margin:${MARGIN[settings.margin] || '20mm'};${num}}`;
  emit('settings', settings);
}

export function setSetting(key, value) {
  settings[key] = value;
  store.writePref('settings', settings);
  applySettings();
}

// Short notices at the top of the screen, optionally with one action ("元に戻す").
let timer = null;

export function toast(msg, opts = {}) {
  const { ms = opts.action ? 6000 : 3200, action } = typeof opts === 'number' ? { ms: opts } : opts;
  const t = document.getElementById('toast');
  t.innerHTML = '';
  const span = document.createElement('span');
  span.textContent = msg;
  t.append(span);
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'toast-action';
    b.textContent = action.label;
    b.addEventListener('click', () => { hide(); action.run(); });
    t.append(b);
  }
  t.hidden = false;
  clearTimeout(timer);
  timer = setTimeout(hide, ms);
}

function hide() {
  clearTimeout(timer);
  document.getElementById('toast').hidden = true;
}

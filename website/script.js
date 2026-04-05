/* ── Nav scroll effect ────────────────────────────────────────────────── */
const nav = document.getElementById('nav');
window.addEventListener('scroll', () => {
  nav.classList.toggle('scrolled', window.scrollY > 20);
}, { passive: true });

/* ── Mobile hamburger ─────────────────────────────────────────────────── */
const hamburger = document.getElementById('hamburger');
const navMobile = document.getElementById('nav-mobile');

hamburger.addEventListener('click', () => {
  const open = hamburger.classList.toggle('open');
  navMobile.classList.toggle('open', open);
});

navMobile.querySelectorAll('a').forEach(a => {
  a.addEventListener('click', () => {
    hamburger.classList.remove('open');
    navMobile.classList.remove('open');
  });
});

/* ── Active nav link on scroll ────────────────────────────────────────── */
const sections = document.querySelectorAll('section[id]');
const navLinks = document.querySelectorAll('.nav-links a');

const sectionObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      navLinks.forEach(a => {
        a.classList.toggle('active', a.getAttribute('href') === `#${entry.target.id}`);
      });
    }
  });
}, { threshold: 0.45 });

sections.forEach(s => sectionObserver.observe(s));

/* ── FAQ accordion ────────────────────────────────────────────────────── */
document.querySelectorAll('.faq-q').forEach(btn => {
  btn.addEventListener('click', () => {
    const expanded = btn.getAttribute('aria-expanded') === 'true';
    document.querySelectorAll('.faq-q').forEach(b => {
      b.setAttribute('aria-expanded', 'false');
      b.nextElementSibling.classList.remove('open');
    });
    if (!expanded) {
      btn.setAttribute('aria-expanded', 'true');
      btn.nextElementSibling.classList.add('open');
    }
  });
});

/* ── Scroll reveal ────────────────────────────────────────────────────── */
const revealTargets = document.querySelectorAll(
  '.feature-card, .provider-card, .step, .stat-item, .faq-item, .section-header, .hero-app-preview, .download-content'
);
revealTargets.forEach(el => el.classList.add('reveal'));

const revealObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (!entry.isIntersecting) return;
    const siblings = [...entry.target.parentElement.querySelectorAll('.reveal')];
    const idx = siblings.indexOf(entry.target);
    setTimeout(() => entry.target.classList.add('visible'), idx * 60);
    revealObserver.unobserve(entry.target);
  });
}, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });

revealTargets.forEach(el => revealObserver.observe(el));

/* ── App window commit animation ──────────────────────────────────────── */
const commitMessages = [
  'obsync: auto 2025-04-05T14:32:11',
  'obsync: pull 2025-04-05T09:15:44',
  'obsync: auto 2025-04-04T22:01:30',
  'obsync: auto 2025-04-04T18:47:02',
];
const firstCommitMsg = document.querySelector('.commit-row .cmsg');
if (firstCommitMsg) {
  firstCommitMsg.style.transition = 'opacity .3s ease';
  let idx = 0;
  setInterval(() => {
    idx = (idx + 1) % commitMessages.length;
    firstCommitMsg.style.opacity = '0';
    setTimeout(() => {
      firstCommitMsg.textContent = commitMessages[idx];
      firstCommitMsg.style.opacity = '1';
    }, 320);
  }, 2800);
}

/* ── Linux "Coming Soon" tooltip on hover ─────────────────────────────── */
const linuxBtn = document.querySelector('.btn-download--disabled');
if (linuxBtn) {
  const tip = document.createElement('div');
  tip.textContent = 'Linux support is coming soon — follow us on GitHub for updates.';
  tip.style.cssText = `
    position:fixed; background:#1a1a2e; color:#f0f0f8;
    border:1px solid rgba(245,158,11,.3); border-radius:8px;
    padding:8px 14px; font-size:13px; max-width:280px;
    box-shadow:0 8px 24px rgba(0,0,0,.5); pointer-events:none;
    opacity:0; transition:opacity .2s; z-index:999; line-height:1.5;
  `;
  document.body.appendChild(tip);

  linuxBtn.addEventListener('mouseenter', (e) => {
    tip.style.opacity = '1';
    positionTip(e);
  });
  linuxBtn.addEventListener('mousemove', positionTip);
  linuxBtn.addEventListener('mouseleave', () => { tip.style.opacity = '0'; });

  function positionTip(e) {
    const x = e.clientX + 14;
    const y = e.clientY - 10;
    const tipW = 280;
    tip.style.left = (x + tipW > window.innerWidth ? x - tipW - 28 : x) + 'px';
    tip.style.top = y + 'px';
  }
}

/* ── macOS dropdown ───────────────────────────────────────────────────── */
const macBtn = document.getElementById('mac-btn');
if (macBtn) {
  const toggle = (force) => {
    const open = typeof force === 'boolean' ? force : !macBtn.classList.contains('open');
    macBtn.classList.toggle('open', open);
    macBtn.setAttribute('aria-expanded', String(open));
  };

  macBtn.addEventListener('click', (e) => {
    // Don't close if clicking a link inside the dropdown
    if (e.target.closest('.mac-option')) return;
    toggle();
  });

  macBtn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    if (e.key === 'Escape') toggle(false);
  });

  // Close when clicking outside
  document.addEventListener('click', (e) => {
    if (!macBtn.contains(e.target)) toggle(false);
  });

  // Close after a link is followed
  macBtn.querySelectorAll('.mac-option').forEach(a => {
    a.addEventListener('click', () => setTimeout(() => toggle(false), 150));
  });
}

/* Astreth — small enhancements: mobile menu, hero video, and in-page form sending. */
(function () {
  'use strict';

  // ----- Mobile menu -----
  var toggle = document.querySelector('[data-menu-toggle]');
  var menu = document.querySelector('[data-menu]');
  if (toggle && menu) {
    var setOpen = function (open) {
      toggle.setAttribute('aria-expanded', String(open));
      document.body.classList.toggle('menu-open', open);
      if (open) {
        var first = menu.querySelector('a');
        if (first) first.focus();
      }
    };
    toggle.addEventListener('click', function () {
      setOpen(toggle.getAttribute('aria-expanded') !== 'true');
    });
    menu.addEventListener('click', function (event) {
      if (event.target.closest('a')) setOpen(false);
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && document.body.classList.contains('menu-open')) {
        setOpen(false);
        toggle.focus();
      }
    });
    var wide = window.matchMedia('(min-width: 900px)');
    var onWide = function () { if (wide.matches) setOpen(false); };
    if (wide.addEventListener) wide.addEventListener('change', onWide);
  }

  // ----- Hero video: don't autoplay for people who prefer reduced motion -----
  var video = document.querySelector('[data-hero-video]');
  if (video && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    video.removeAttribute('autoplay');
    video.pause();
  }

  // ----- Campaign video: show only a play button until the visitor starts it -----
  var campaignVideo = document.querySelector('[data-campaign-video]');
  var campaignPlay = document.querySelector('[data-campaign-play]');
  if (campaignVideo && campaignPlay) {
    campaignVideo.controls = false;
    campaignPlay.hidden = false;
    campaignPlay.addEventListener('click', function () {
      campaignPlay.hidden = true;
      campaignVideo.controls = true;
      var started = campaignVideo.play();
      if (started && started.catch) started.catch(function () {});
      campaignVideo.focus();
    });
  }

  // ----- Long pages: mark the current section in the page menu, and show a way back up -----
  var pageNav = document.querySelector('[data-page-nav]');
  if (pageNav && 'IntersectionObserver' in window) {
    var pairs = [];
    Array.prototype.forEach.call(pageNav.querySelectorAll('a[href^="#"]'), function (link) {
      var target = document.getElementById(link.getAttribute('href').slice(1));
      var section = target && (target.closest('section') || target);
      if (section) pairs.push({ section: section, link: link });
    });
    var sectionObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        pairs.forEach(function (pair) {
          if (pair.section === entry.target) pair.link.setAttribute('aria-current', 'true');
          else pair.link.removeAttribute('aria-current');
        });
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    pairs.forEach(function (pair) { sectionObserver.observe(pair.section); });
  }
  var toTop = document.querySelector('[data-to-top]');
  if (toTop) {
    var showToTop = function () { toTop.hidden = window.scrollY < 700; };
    window.addEventListener('scroll', showToTop, { passive: true });
    showToTop();
  }

  // ----- Arriving on a link to a section: line up again once images have loaded and changed the page height -----
  if (window.location.hash.length > 1) {
    var visitorMoved = false;
    ['wheel', 'touchstart', 'keydown', 'mousedown'].forEach(function (type) {
      window.addEventListener(type, function () { visitorMoved = true; }, { passive: true, once: true });
    });
    window.addEventListener('load', function () {
      if (visitorMoved) return;
      var arrivedAt = document.getElementById(decodeURIComponent(window.location.hash.slice(1)));
      if (arrivedAt) arrivedAt.scrollIntoView({ behavior: 'auto' });
    });
  }

  // ----- Forms: send to the form service without leaving the page -----
  var forms = document.querySelectorAll('form[data-ajax-form]');
  Array.prototype.forEach.call(forms, function (form) {
    var status = form.querySelector('.form__status');
    var button = form.querySelector('[type="submit"]');
    var isNewsletter = form.classList.contains('newsletter__form');

    function setStatus(text, kind) {
      if (!status) return;
      status.textContent = text;
      status.className = 'form__status' + (kind ? ' ' + kind : '');
    }

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var data = new FormData(form);

      // Send the checkbox choices as one readable line.
      var interests = data.getAll('interested_in');
      if (interests.length) {
        data.delete('interested_in');
        data.append('interested_in', interests.join(', '));
      }
      // Put the visitor's subject in the notification email's subject line.
      var subject = data.get('subject');
      if (subject && data.has('_subject')) data.set('_subject', 'Astreth website: ' + subject);

      if (button) button.disabled = true;
      setStatus('Sending…', '');

      fetch(form.action, { method: 'POST', body: data, headers: { Accept: 'application/json' } })
        .then(function (response) {
          if (response.ok) {
            return response.json().catch(function () { return {}; }).then(function (body) {
              // Kit answers 200 even when it turns a sign-up down, and says so in the body.
              if (body && body.status === 'failed') {
                var messages = body.errors && body.errors.messages;
                throw new Error(messages && messages.length ? messages.join(', ') : 'The form service returned an error.');
              }
              // Kit sometimes asks the visitor to pass a quick check on its own page first.
              if (body && body.status === 'quarantined' && /^https:\/\/([a-z0-9-]+\.)*kit\.com\//.test(body.url || '')) {
                window.location.href = body.url;
                return;
              }
              form.reset();
              setStatus(isNewsletter ? 'Thanks for signing up!' : 'Thank you! Your message has been sent.', 'is-success');
            });
          }
          return response.json().catch(function () { return {}; }).then(function (body) {
            var detail = body && body.errors ? body.errors.map(function (e) { return e.message; }).join(', ') : '';
            throw new Error(detail || 'The form service returned an error.');
          });
        })
        .catch(function (error) {
          setStatus('Sorry, that didn’t go through (' + error.message + '). Please try again in a moment.', 'is-error');
        })
        .finally(function () {
          if (button) button.disabled = false;
        });
    });
  });
})();

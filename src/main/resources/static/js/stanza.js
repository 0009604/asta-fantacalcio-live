// Center the auction plate view during activation
function centerAstaView() {
  const piatto = document.getElementById('piattoAsta');
  if (!piatto) return;

  const viewportHeight = window.innerHeight;
  const piattoRect = piatto.getBoundingClientRect();
  const targetScroll = piattoRect.top + window.scrollY - (viewportHeight / 2) + (piattoRect.height / 2);

  window.scrollTo({
    top: targetScroll,
    behavior: 'smooth'
  });
}

if (!astaAttivaPrecedente) {
  astaAttivaPrecedente = true;
  document.body.classList.add('focus-asta');
  setTimeout(centerAstaView, 100);
}

// Compact confirm button event listener
document.getElementById('btnConfermaCompact').addEventListener('click', () => {
  if (!valoreStaged) return;
  beep();
  stompClient.publish({
    destination: `/app/stanza/${codiceStanza}/rilancio`,
    body: JSON.stringify({ importo: valoreStaged })
  });
});
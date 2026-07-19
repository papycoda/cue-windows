const { desktopCapturer, screen } = require('electron');

function thumbnailSize(display) {
  const scale = display.scaleFactor || 1;
  return {
    width: Math.max(1, Math.floor(display.size.width * scale)),
    height: Math.max(1, Math.floor(display.size.height * scale))
  };
}

function findDisplaySource(sources, display) {
  return sources.find((source) => String(source.display_id) === String(display.id));
}

async function sourcesFor(display) {
  return desktopCapturer.getSources({ types: ['screen'], thumbnailSize: thumbnailSize(display) });
}

async function captureScreenshot() {
  const primary = screen.getPrimaryDisplay();
  let selected = primary;
  try {
    selected = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()) || primary;
  } catch {
    selected = primary;
  }

  let sources = await sourcesFor(selected);
  if (!sources.length) return null;
  let source = findDisplaySource(sources, selected);

  if (!source && String(selected.id) !== String(primary.id)) {
    const primarySources = await sourcesFor(primary);
    source = findDisplaySource(primarySources, primary);
    if (source) sources = primarySources;
  }
  source = source || findDisplaySource(sources, primary) || sources[0];

  const image = source && source.thumbnail;
  if (!image || image.isEmpty()) return null;
  return image.toDataURL();
}

module.exports = { captureScreenshot };

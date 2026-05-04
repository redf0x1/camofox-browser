const express = require('express');

let server = null;
let port = null;

function createTestApp() {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  
  // Simple pages for navigation tests
  app.get('/pageA', (req, res) => {
    res.send(`
      <!DOCTYPE html>
      <html><head><title>Page A</title></head>
      <body>
        <h1>Welcome to Page A</h1>
        <p>This is the first test page.</p>
        <a href="/pageB">Go to Page B</a>
      </body></html>
    `);
  });
  
  app.get('/pageB', (req, res) => {
    res.send(`
      <!DOCTYPE html>
      <html><head><title>Page B</title></head>
      <body>
        <h1>Welcome to Page B</h1>
        <p>This is the second test page.</p>
        <a href="/pageA">Go to Page A</a>
      </body></html>
    `);
  });

  app.get('/long-snapshot', (req, res) => {
    const sections = Array.from({ length: 500 }, (_, index) => (
      `<p>Section ${index + 1}: ${'Long snapshot content for pagination coverage. '.repeat(6)}</p>`
    )).join('');

    res.send(`
      <!DOCTYPE html>
      <html><head><title>Long Snapshot</title></head>
      <body>
        <h1>Long Snapshot Page</h1>
        ${sections}
        <a href="/pageA">Return to Page A</a>
      </body></html>
    `);
  });

  app.get('/slow', (req, res) => {
    const parsedDelay = Number.parseInt(String(req.query.delay || '1000'), 10);
    const delay = Number.isFinite(parsedDelay) && parsedDelay >= 0 ? parsedDelay : 1000;
    setTimeout(() => {
      res.send(`
        <!DOCTYPE html>
        <html><head><title>Slow Page</title></head>
        <body>
          <h1>Slow Page</h1>
          <p id="delay">Delay: ${delay}</p>
        </body></html>
      `);
    }, delay);
  });
  
  // Page with multiple links for links extraction test
  app.get('/links', (req, res) => {
    res.send(`
      <!DOCTYPE html>
      <html><head><title>Links Page</title></head>
      <body>
        <h1>Links Collection</h1>
        <ul>
          <li><a href="https://example.com/link1">Example Link 1</a></li>
          <li><a href="https://example.com/link2">Example Link 2</a></li>
          <li><a href="https://example.com/link3">Example Link 3</a></li>
          <li><a href="https://example.com/link4">Example Link 4</a></li>
          <li><a href="https://example.com/link5">Example Link 5</a></li>
        </ul>
      </body></html>
    `);
  });
  
  // Page for typing tests with live preview
  app.get('/typing', (req, res) => {
    res.send(`
      <!DOCTYPE html>
      <html><head><title>Typing Test</title></head>
      <body>
        <h1>Typing Test Page</h1>
        <input type="text" id="input" placeholder="Type here..." />
        <div id="preview"></div>
        <script>
          document.getElementById('input').addEventListener('input', (e) => {
            document.getElementById('preview').textContent = 'Preview: ' + e.target.value;
          });
        </script>
      </body></html>
    `);
  });
  
  // Page for Enter key test - redirects on Enter
  app.get('/enter', (req, res) => {
    res.send(`
      <!DOCTYPE html>
      <html><head><title>Enter Test</title></head>
      <body>
        <h1>Press Enter Test</h1>
        <input type="text" id="searchInput" placeholder="Type and press Enter..." />
        <script>
          document.getElementById('searchInput').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
              const value = e.target.value;
              window.location.href = '/entered?value=' + encodeURIComponent(value);
            }
          });
        </script>
      </body></html>
    `);
  });
  
  app.get('/entered', (req, res) => {
    const value = req.query.value || '';
    res.send(`
      <!DOCTYPE html>
      <html><head><title>Entered</title></head>
      <body>
        <h1>Entry Received</h1>
        <p id="result">Entered: ${value}</p>
      </body></html>
    `);
  });
  
  // Form submission test
  app.get('/form', (req, res) => {
    res.send(`
      <!DOCTYPE html>
      <html><head><title>Form Test</title></head>
      <body>
        <h1>Form Submission Test</h1>
        <form action="/submitted" method="POST">
          <label for="username">Username:</label>
          <input type="text" id="username" name="username" />
          <br/>
          <label for="email">Email:</label>
          <input type="email" id="email" name="email" />
          <br/>
          <button type="submit" id="submitBtn">Submit</button>
        </form>
      </body></html>
    `);
  });
  
  app.post('/submitted', (req, res) => {
    const { username, email } = req.body;
    res.send(`
      <!DOCTYPE html>
      <html><head><title>Submitted</title></head>
      <body>
        <h1>Form Submitted Successfully</h1>
        <p id="username">Username: ${username || ''}</p>
        <p id="email">Email: ${email || ''}</p>
      </body></html>
    `);
  });
  
  // Page with refresh counter (to verify refresh actually works)
  let refreshCount = 0;
  app.get('/refresh-test', (req, res) => {
    refreshCount++;
    res.send(`
      <!DOCTYPE html>
      <html><head><title>Refresh Test</title></head>
      <body>
        <h1>Refresh Counter</h1>
        <p id="count">Count: ${refreshCount}</p>
      </body></html>
    `);
  });
  
  // Reset refresh counter (for test isolation)
  app.post('/reset-refresh-count', (req, res) => {
    refreshCount = 0;
    res.json({ ok: true });
  });
  
  // Page with clickable button
  app.get('/click', (req, res) => {
    res.send(`
      <!DOCTYPE html>
      <html><head><title>Click Test</title></head>
      <body>
        <h1>Click Test Page</h1>
        <button id="clickMe">Click Me</button>
        <div id="result"></div>
        <script>
          document.getElementById('clickMe').addEventListener('click', () => {
            document.getElementById('result').textContent = 'Button was clicked!';
          });
        </script>
      </body></html>
    `);
  });

  app.get('/select-redirect', (_req, res) => {
    res.send(`
      <!DOCTYPE html>
      <html><head><title>Select Redirect</title></head>
      <body>
        <h1>Select Redirect Test</h1>
        <select id="target-select">
          <option value="">Choose</option>
          <option value="http://169.254.169.254/latest/meta-data">Metadata</option>
        </select>
        <script>
          document.getElementById('target-select').addEventListener('change', (event) => {
            if (event.target.value) {
              window.location.href = event.target.value;
            }
          });
        </script>
      </body></html>
    `);
  });
  
  // Echo endpoint for macro expansion testing - echoes the full request URL
  app.get('/echo-url', (req, res) => {
    res.send(`
      <!DOCTYPE html>
      <html><head><title>Echo URL</title></head>
      <body>
        <h1>URL Echo</h1>
        <pre id="url">${req.originalUrl}</pre>
        <pre id="query">${JSON.stringify(req.query)}</pre>
      </body></html>
    `);
  });
  
  // Page with scrollable content
  app.get('/scroll', (req, res) => {
    const items = Array.from({ length: 100 }, (_, i) => `<p id="item${i}">Item ${i}</p>`).join('\n');
    res.send(`
      <!DOCTYPE html>
      <html><head><title>Scroll Test</title></head>
      <body style="height: 5000px;">
        <h1>Scroll Test Page</h1>
        ${items}
        <div id="bottom">Bottom of page</div>
      </body></html>
    `);
  });

  // Page with horizontally scrollable content
  app.get('/scroll-horizontal', (req, res) => {
    res.send(`
      <!DOCTYPE html>
      <html><head><title>Horizontal Scroll Test</title></head>
      <body>
        <div id="container" style="width: 300px; height: 300px; overflow: auto;">
          <div id="wide-content" style="width: 5000px; height: 5000px;">
            <span id="origin">Origin</span>
            <span id="far-right" style="position: absolute; left: 4500px; top: 10px;">Far Right</span>
          </div>
        </div>
        <div id="scroll-info"></div>
        <script>
          const c = document.getElementById('container');
          document.getElementById('scroll-info').textContent = 'scrollLeft:' + c.scrollLeft + ' scrollTop:' + c.scrollTop;
          c.addEventListener('scroll', () => {
            document.getElementById('scroll-info').textContent = 'scrollLeft:' + c.scrollLeft + ' scrollTop:' + c.scrollTop;
          });
        </script>
      </body></html>
    `);
  });

  const pngPixel = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO0pQ4sAAAAASUVORK5CYII=',
    'base64',
  );

  app.get('/assets/:filename', (req, res) => {
    const name = String(req.params.filename || '');
    if (name === 'hero.png' || name === 'lazy.png') {
      res.set('Content-Type', 'image/png');
      return res.send(pngPixel);
    }
    return res.status(404).send('Not found');
  });

  app.get('/images', (req, res) => {
    res.send(`
      <!DOCTYPE html>
      <html>
        <head><title>Images Page</title></head>
        <body>
          <main id="gallery">
            <img id="hero-image" src="/assets/hero.png" alt="Hero image" width="32" height="24" />
            <img
              id="inline-image"
              src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="
              alt="Inline image"
              width="1"
              height="1"
            />
            <img id="blob-image" alt="Blob image" width="8" height="8" />
            <img id="lazy-image" src="/assets/lazy.png" loading="lazy" alt="Lazy image" width="20" height="20" />
          </main>
          <script>
            const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#ff3366"/></svg>';
            const blob = new Blob([svg], { type: 'image/svg+xml' });
            document.getElementById('blob-image').src = URL.createObjectURL(blob);
          </script>
        </body>
      </html>
    `);
  });

  app.get('/structured-products', (_req, res) => {
    res.send(`
      <!DOCTYPE html>
      <html>
        <head><title>Structured Products</title></head>
        <body>
          <main id="catalog">
            <h1>Catalog</h1>
            <article class="product">
              <h2 class="name">Red Mug</h2>
              <p class="price">19.99</p>
              <a class="product-link" href="/products/red-mug">View product</a>
              <section class="seller">
                <span class="seller-name">North Shop</span>
              </section>
              <ul>
                <li class="badge">Hot</li>
                <li class="badge">Ceramic</li>
              </ul>
            </article>
            <article class="product">
              <h2 class="name">Blue Plate</h2>
              <p class="price">24.5</p>
              <a class="product-link" href="/products/blue-plate">View product</a>
              <section class="seller">
                <span class="seller-name">South Shop</span>
              </section>
              <ul>
                <li class="badge">New</li>
              </ul>
            </article>
          </main>
        </body>
      </html>
    `);
  });

  app.get('/structured-missing-price', (_req, res) => {
    res.send(`
      <!DOCTYPE html>
      <html>
        <head><title>Structured Missing Price</title></head>
        <body>
          <main id="catalog">
            <h1>Catalog</h1>
            <article class="product">
              <h2 class="name">Red Mug</h2>
              <p class="price">19.99</p>
            </article>
            <article class="product">
              <h2 class="name">Blue Plate</h2>
            </article>
          </main>
        </body>
      </html>
    `);
  });

  // Native download fixture for download-listener tests
  app.get('/download-file', (req, res) => {
    const content = Buffer.from('camofox-test-download-content');
    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="test-download.bin"',
      'Content-Length': String(content.length),
    });
    res.send(content);
  });
  
  return app;
}

async function startTestSite(preferredPort = 0) {
  const app = createTestApp();
  
  return new Promise((resolve, reject) => {
    server = app.listen(preferredPort, () => {
      port = server.address().port;
      console.log(`Test site running on port ${port}`);
      resolve(port);
    });
    server.on('error', reject);
  });
}

async function stopTestSite() {
  if (server) {
    return new Promise((resolve) => {
      server.close(() => {
        server = null;
        port = null;
        resolve();
      });
    });
  }
}

function getTestSiteUrl() {
  if (!port) throw new Error('Test site not started');
  return `http://localhost:${port}`;
}

module.exports = {
  startTestSite,
  stopTestSite,
  getTestSiteUrl
};

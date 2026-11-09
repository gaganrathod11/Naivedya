import { auth, db } from './firebase.js';
import { signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { collection, addDoc, getDocs, serverTimestamp, doc, deleteDoc, updateDoc, increment, getDoc, writeBatch } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* ============================================================
   Naivedya — Wine Shop POS
   Helpers, state & utilities
   ============================================================ */

const $ = (id) => document.getElementById(id);

const money = (n) =>
  '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const LOW_STOCK = 5;
const CATEGORIES = ["All", "Whisky", "Rum", "Brandy", "Vodka & Gin", "Beer", "Wine & RTD"];
const CAT_COLORS = {
  "Whisky": "#A0522D",
  "Rum": "#7B3F00",
  "Brandy": "#872D2D",
  "Vodka & Gin": "#2C7A7B",
  "Beer": "#D69E2E",
  "Wine & RTD": "#722F37",
  "Uncategorized": "#8B7A80",
};

let currentProduct = null;
let cart = [];
let allProductsCache = [];
let barcodeDetector = null;
let activeScannerInput = 'pBarcode';
let currentCategoryTab = 'All';
let toastTimer = null;

if ('BarcodeDetector' in window) {
  try {
    barcodeDetector = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'code_128', 'code_39', 'upc_a', 'upc_e'] });
  } catch (e) { barcodeDetector = null; }
}

const buzz = () => { if (navigator.vibrate) navigator.vibrate(80); };

const glassIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3h10c0 4.4-1.9 7.5-5 7.5S7 7.4 7 3Z"/><path d="M12 10.5V19"/><path d="M8 21h8"/></svg>`;

const chevronIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>`;

const closeIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>`;

function emptyStateHTML(title, sub) {
  return `<div class="empty-state">${glassIcon}<div class="empty-title">${esc(title)}</div><div class="empty-sub">${esc(sub)}</div></div>`;
}

/* ---------- Toast ---------- */
window.showToast = function (msg, kind = 'success') {
  const isError = kind === true || kind === 'error';
  const t = $('toast');
  const type = isError ? 'error' : (kind === 'info' ? 'info' : 'success');
  $('toastIcon').textContent = type === 'error' ? '⚠️' : (type === 'info' ? 'ℹ️' : '✅');
  $('toastMsg').textContent = msg;
  t.className = 'show ' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, 3200);
};

/* ---------- Navigation ---------- */
window.nav = function (id) {
  document.querySelectorAll('[id^="screen-"]').forEach((el) => el.classList.add('hidden'));
  const target = $('screen-' + id);
  if (target) target.classList.remove('hidden');
  window.scrollTo({ top: 0 });
  stopCameraScan();
  stopAdminScanner();
  if (id === 'admin') loadAdminProducts();
  if (id === 'reports') loadReports();
  if (id === 'retail') loadAllProductsForSearch();
};

/* ============================================================
   AUTH
   ============================================================ */
function prettyAuthError(err) {
  const code = (err && err.code) || '';
  if (code.includes('invalid-credential') || code.includes('wrong-password') || code.includes('user-not-found')) return 'Incorrect email or password';
  if (code.includes('too-many-requests')) return 'Too many attempts — please wait a moment';
  if (code.includes('network')) return 'Network error — check your internet connection';
  if (code.includes('invalid-email')) return 'That email address looks invalid';
  return (err && err.message) ? err.message.replace('Firebase: ', '') : 'Sign in failed';
}

window.handleLogin = async function () {
  const email = $('loginEmail').value.trim();
  const pass = $('loginPassword').value;
  if (!email || !pass) return showToast('Enter email and password', 'error');
  const btn = $('loginBtn');
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Signing in…';
  try {
    await signInWithEmailAndPassword(auth, email, pass);
  } catch (err) {
    showToast(prettyAuthError(err), 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
};

window.handleLogout = async function () {
  try { await signOut(auth); } catch (e) { /* ignore */ }
  nav('landing');
};

onAuthStateChanged(auth, (user) => { if (user) nav('admin'); });

/* ============================================================
   ADMIN — add / list / edit products
   ============================================================ */
window.switchTab = function (category) {
  currentCategoryTab = category;
  renderProductTabs();
  loadAdminProducts();
};

function renderProductTabs() {
  const tabsContainer = $('categoryTabs');
  tabsContainer.innerHTML = CATEGORIES.map((cat) => {
    const isActive = currentCategoryTab === cat ? 'active' : '';
    return `<button class="cat-tab ${isActive}" onclick="switchTab('${cat}')">${esc(cat)}</button>`;
  }).join('');
  const active = tabsContainer.querySelector('.cat-tab.active');
  if (active && active.scrollIntoView) {
    try { active.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' }); } catch (e) { /* older browsers */ }
  }
}

window.addProduct = async function () {
  const category = $('pCategory').value;
  const name = $('pName').value.trim();
  const barcode = $('pBarcode').value.trim() || "NO-BARCODE";
  const cost = parseFloat($('pCost').value);
  const price = parseFloat($('pPrice').value);
  const stock = parseInt($('pStock').value, 10) || 0;

  if (!name) return showToast('Please enter the product name', 'error');
  if (isNaN(cost) || cost < 0) return showToast('Enter a valid cost price', 'error');
  if (isNaN(price) || price < 0) return showToast('Enter a valid selling price', 'error');

  const btn = $('addProductBtn');
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Saving…';

  try {
    await addDoc(collection(db, "products"), {
      category, name, barcode,
      costPrice: cost, sellingPrice: price, stock,
      createdAt: serverTimestamp()
    });
    showToast(`${name} added`);
    $('pName').value = '';
    $('pBarcode').value = '';
    $('pCost').value = '';
    $('pPrice').value = '';
    $('pStock').value = '0';
    currentCategoryTab = category;
    loadAdminProducts();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
};

async function loadAdminProducts() {
  renderProductTabs();
  const list = $('productList');
  list.innerHTML = `<div class="empty-state"><div class="empty-title">Loading catalogue…</div></div>`;

  try {
    const snap = await getDocs(collection(db, "products"));
    const products = [];
    snap.forEach((d) => { if (d && d.id) products.push({ id: d.id, ...d.data() }); });

    // Keep the retail-search cache fresh too
    allProductsCache = products;

    // Stat chips
    const stockValue = products.reduce((s, p) => s + Number(p.costPrice || 0) * Number(p.stock || 0), 0);
    const lowCount = products.filter((p) => Number(p.stock || 0) <= LOW_STOCK).length;
    $('statProducts').textContent = products.length;
    $('statStockValue').textContent = '₹' + Math.round(stockValue).toLocaleString('en-IN');
    $('statLowStock').textContent = lowCount;

    const visible = currentCategoryTab === 'All'
      ? products
      : products.filter((p) => (p.category || 'Uncategorized') === currentCategoryTab);
    visible.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));

    list.innerHTML = visible.length
      ? visible.map(productCardHTML).join('')
      : emptyStateHTML('No products here yet', 'Add your first product using the form above.');

    $('totalProducts').textContent = visible.length + (visible.length === 1 ? ' Item' : ' Items');
  } catch (err) {
    list.innerHTML = emptyStateHTML('Could not load products', 'Check your internet connection and reopen this page.');
  }
}

function productCardHTML(p) {
  const cat = p.category || 'Uncategorized';
  const spine = CAT_COLORS[cat] || CAT_COLORS['Uncategorized'];
  const cost = Number(p.costPrice || 0);
  const price = Number(p.sellingPrice ?? p.price ?? 0);
  const stock = Number(p.stock || 0);
  const profit = price - cost;

  const pill = stock <= 0
    ? '<span class="pill out">Out of stock</span>'
    : stock <= LOW_STOCK
      ? `<span class="pill low">Low · ${stock}</span>`
      : `<span class="pill ok">Stock ${stock}</span>`;

  const barcodeText = p.barcode && p.barcode !== 'NO-BARCODE' ? esc(p.barcode) : 'No barcode';

  return `
    <div class="product-card" style="--spine:${spine}" onclick="openEditModal('${esc(p.id)}')">
      <div class="product-info">
        <div class="product-name">${esc(p.name || 'Unnamed product')}</div>
        <div class="product-meta"><span class="cat-dot"></span>${esc(cat)} · ${barcodeText}</div>
        <div class="product-meta">
          <span>Cost ${money(cost)}</span>
          ${cost > 0 ? `<span class="badge-price">Profit ${money(profit)}</span>` : ''}
        </div>
      </div>
      <div class="product-right">
        <div class="product-price">${money(price)}</div>
        ${pill}
        <span class="product-arrow">${chevronIcon}</span>
      </div>
    </div>`;
}

window.openEditModal = async function (id) {
  try {
    const docSnap = await getDoc(doc(db, "products", id));
    if (docSnap.exists()) {
      const p = docSnap.data();
      $('editId').value = id;
      $('editCategory').value = p.category || "Whisky";
      $('editName').value = p.name || '';
      $('editBarcode').value = p.barcode === "NO-BARCODE" ? "" : (p.barcode || "");
      $('editCost').value = p.costPrice ?? 0;
      $('editPrice').value = p.sellingPrice ?? p.price ?? 0;
      $('editStock').value = p.stock ?? 0;
      $('editModal').classList.remove('hidden');
      document.body.classList.add('modal-open');
    }
  } catch (err) { showToast(err.message, 'error'); }
};

window.closeEditModal = function (event) {
  if (event && event.target !== event.currentTarget) return;
  stopAdminScanner();
  $('editModal').classList.add('hidden');
  document.body.classList.remove('modal-open');
};

window.saveProductUpdate = async function () {
  const id = $('editId').value;
  const category = $('editCategory').value;
  const name = $('editName').value.trim();
  const barcode = $('editBarcode').value.trim() || "NO-BARCODE";
  const cost = parseFloat($('editCost').value);
  const price = parseFloat($('editPrice').value);
  const stock = parseInt($('editStock').value, 10);

  if (!name) return showToast('Please enter the product name', 'error');
  if (isNaN(cost) || cost < 0) return showToast('Enter a valid cost price', 'error');
  if (isNaN(price) || price < 0) return showToast('Enter a valid selling price', 'error');
  if (isNaN(stock) || stock < 0) return showToast('Enter a valid stock count', 'error');

  const btn = $('saveProductBtn');
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Saving…';

  try {
    await updateDoc(doc(db, "products", id), { category, name, barcode, costPrice: cost, sellingPrice: price, stock });
    showToast('Product updated');
    closeEditModal();
    loadAdminProducts();
    loadAllProductsForSearch();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
};

window.deleteProduct = async function (id) {
  if (!confirm("Are you sure you want to completely delete this product? This cannot be undone.")) return;
  try {
    await deleteDoc(doc(db, "products", id));
    showToast('Product deleted');
    closeEditModal();
    loadAdminProducts();
    loadAllProductsForSearch();
  } catch (err) { showToast(err.message, 'error'); }
};

/* ============================================================
   BARCODE SCANNERS (camera)
   ============================================================ */
function makeScanner(boxId, videoId) {
  let interval = null;
  return {
    get running() { return !!interval; },
    async start(onCode) {
      if (!barcodeDetector) return showToast('Scanner not supported on this browser — type the barcode instead', 'error');
      if (interval) return; // already running
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      } catch (err) {
        return showToast('Camera access denied or unavailable', 'error');
      }
      const video = $(videoId);
      $(boxId).classList.remove('hidden');
      video.srcObject = stream;
      try { await video.play(); } catch (e) { /* autoplay guard */ }
      interval = setInterval(async () => {
        try {
          const codes = await barcodeDetector.detect(video);
          if (codes.length > 0) {
            const code = codes[0].rawValue;
            this.stop();
            onCode(code);
          }
        } catch (e) { /* keep scanning */ }
      }, 350);
    },
    stop() {
      if (interval) { clearInterval(interval); interval = null; }
      const video = $(videoId);
      if (video && video.srcObject) {
        video.srcObject.getTracks().forEach((t) => t.stop());
        video.srcObject = null;
      }
      const box = $(boxId);
      if (box) box.classList.add('hidden');
    }
  };
}

const adminScanner = makeScanner('adminScannerBox', 'admin-scanner-video');
const retailScanner = makeScanner('scannerBox', 'scanner-video');

window.startAdminScanner = function (inputId = 'pBarcode') {
  activeScannerInput = inputId;
  return adminScanner.start((code) => {
    $(inputId).value = code;
    buzz();
    showToast('Barcode scanned');
  });
};
window.stopAdminScanner = function () { adminScanner.stop(); };

window.startCameraScan = function () {
  return retailScanner.start((code) => {
    $('scanBarcode').value = code;
    buzz();
    searchBarcode();
  });
};
window.stopCameraScan = function () { retailScanner.stop(); };

/* ============================================================
   RETAIL — search & cart
   ============================================================ */
async function loadAllProductsForSearch() {
  try {
    const snap = await getDocs(collection(db, "products"));
    const products = [];
    snap.forEach((d) => { if (d && d.id) products.push({ id: d.id, ...d.data() }); });
    allProductsCache = products;
  } catch (err) { /* keep previous cache */ }
}

function hideResults() {
  $('scanResults').classList.add('hidden');
  $('scanResults').innerHTML = '';
}

window.clearSearchName = function () {
  $('searchName').value = '';
  searchByName();
  $('searchName').focus();
};

function renderResults(matches) {
  const box = $('scanResults');
  if (!matches.length) {
    box.innerHTML = `<div class="no-results">No matching products found</div>`;
  } else {
    box.innerHTML = matches.slice(0, 12).map((p) => {
      const price = Number(p.sellingPrice ?? p.price ?? 0);
      const stock = Number(p.stock || 0);
      return `
        <div class="result-row" onclick="selectProduct('${esc(p.id)}')">
          <div>
            <div class="result-name">${esc(p.name || 'Unnamed product')}</div>
            <div class="result-sub">${esc(p.category || '')} · ${stock > 0 ? stock + ' in stock' : 'Out of stock'}</div>
          </div>
          <div class="result-price">${money(price)}</div>
        </div>`;
    }).join('');
  }
  box.classList.remove('hidden');
}

window.searchBarcode = function () {
  const q = $('scanBarcode').value.trim();
  if (!q) return hideResults();
  const matches = allProductsCache.filter(
    (p) => String(p.barcode || '').includes(q) && p.barcode !== 'NO-BARCODE'
  );
  renderResults(matches);
};

window.searchByName = function () {
  const q = $('searchName').value.toLowerCase().trim();
  if (!q) return hideResults();
  const matches = allProductsCache.filter(
    (p) => String(p.name || '').toLowerCase().includes(q)
  );
  renderResults(matches);
};

/* Select from search results by product ID (fixes wrong-product bug) */
window.selectProduct = function (id) {
  hideResults();
  $('scanBarcode').value = '';
  $('searchName').value = '';
  const product = allProductsCache.find((p) => p.id === id);
  if (!product) return showToast('Product not found', 'error');
  const stock = Number(product.stock || 0);
  if (stock <= 0) return showToast('Out of stock!', 'error');

  currentProduct = product;
  const price = Number(product.sellingPrice ?? product.price ?? 0);
  $('rName').textContent = product.name || 'Unnamed product';
  $('rCat').textContent = `${product.category || ''} · ${money(price)} · ${stock} in stock`;
  $('rQty').value = '1';
  $('rQty').max = String(stock);
  $('rOverridePrice').value = '';
  $('productInfo').classList.remove('hidden');
  $('productInfo').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};

window.addToCart = function () {
  if (!currentProduct) return;
  const qtyInput = $('rQty');
  let qty = parseInt(qtyInput.value, 10);
  if (!qty || qty < 1) { qty = 1; qtyInput.value = '1'; }

  const overrideRaw = $('rOverridePrice').value;
  const override = overrideRaw.trim() === '' ? NaN : parseFloat(overrideRaw);
  if (!isNaN(override) && override < 0) return showToast('Price cannot be negative', 'error');

  const stock = Number(currentProduct.stock || 0);
  const existing = cart.find((i) => i.id === currentProduct.id);
  const already = existing ? existing.qty : 0;
  if (already + qty > stock) {
    return showToast(already > 0 ? `Only ${stock} in stock (${already} already in cart)` : `Only ${stock} in stock`, 'error');
  }

  const price = isNaN(override) ? Number(currentProduct.sellingPrice ?? currentProduct.price ?? 0) : override;

  if (existing) {
    existing.qty += qty;
    existing.price = price; // apply latest price if overridden
  } else {
    cart.push({
      id: currentProduct.id,
      name: currentProduct.name,
      barcode: currentProduct.barcode,
      category: currentProduct.category,
      costPrice: Number(currentProduct.costPrice || 0),
      price,
      qty
    });
  }

  renderCart();
  $('productInfo').classList.add('hidden');
  currentProduct = null;
  buzz();
  showToast(`${qty} × added to cart`);
  $('scanBarcode').focus();
};

function renderCart() {
  const list = $('cartList');
  const count = cart.reduce((s, i) => s + i.qty, 0);
  $('cartCount').textContent = count ? `${count} item${count > 1 ? 's' : ''}` : 'Empty';

  if (!cart.length) {
    list.innerHTML = emptyStateHTML('Cart is empty', 'Scan or search a product to begin a sale.');
    $('cartTotal').textContent = money(0);
    $('checkoutBtn').disabled = true;
    return;
  }

  let total = 0;
  list.innerHTML = cart.map((item, idx) => {
    total += item.price * item.qty;
    return `
      <div class="list-item">
        <div class="list-main">
          <div class="list-title">${esc(item.name)}</div>
          <div class="list-sub">${item.qty} × ${money(item.price)}</div>
        </div>
        <div class="list-amount">${money(item.price * item.qty)}</div>
        <button class="remove-btn" onclick="removeCartItem(${idx})" aria-label="Remove ${esc(item.name)}">${closeIcon}</button>
      </div>`;
  }).join('');

  $('cartTotal').textContent = money(total);
  $('checkoutBtn').disabled = false;
}

window.removeCartItem = function (idx) {
  cart.splice(idx, 1);
  renderCart();
};

window.clearCart = function () {
  if (!cart.length) return;
  if (!confirm('Clear all items from the cart?')) return;
  cart = [];
  renderCart();
  showToast('Cart cleared', 'info');
};

/* ============================================================
   CHECKOUT — atomic batched write
   ============================================================ */
window.checkout = async function () {
  if (!cart.length) return showToast('Cart is empty', 'error');

  const btn = $('checkoutBtn');
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Processing…';

  const totalRevenue = cart.reduce((s, i) => s + i.price * i.qty, 0);
  const totalProfit = cart.reduce((s, i) => s + (i.price - i.costPrice) * i.qty, 0);
  const totalUnits = cart.reduce((s, i) => s + i.qty, 0);

  try {
    // Pre-assign the transaction ID so everything commits in ONE atomic batch:
    // if any part fails, nothing is written and stock stays correct.
    const txnRef = doc(collection(db, "transactions"));
    const batch = writeBatch(db);
    batch.set(txnRef, {
      date: serverTimestamp(),
      total: totalRevenue,
      profit: totalProfit,
      items: cart.length,
      units: totalUnits
    });
    for (const item of cart) {
      batch.set(doc(db, "transactions", txnRef.id, "lineItems"), {
        name: item.name,
        qty: item.qty,
        costPrice: item.costPrice,
        unitPrice: item.price,
        lineTotal: item.price * item.qty,
        lineProfit: (item.price - item.costPrice) * item.qty
      });
      batch.update(doc(db, "products", item.id), { stock: increment(-item.qty) });
    }
    await batch.commit();

    cart = [];
    renderCart();
    $('productInfo').classList.add('hidden');
    currentProduct = null;
    $('rName').textContent = '';
    $('rCat').textContent = '';
    loadAllProductsForSearch();
    buzz();
    showToast(`Sale complete · ${money(totalRevenue)}`);
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
};

/* ============================================================
   REPORTS
   ============================================================ */
window.loadReports = async function () {
  const list = $('txnList');
  list.innerHTML = `<div class="empty-state"><div class="empty-title">Loading sales…</div></div>`;

  try {
    const snap = await getDocs(collection(db, "transactions"));
    const txns = [];
    snap.forEach((d) => {
      const t = d.data() || {};
      txns.push({ id: d.id, ...t });
    });
    txns.sort((a, b) => {
      const ta = a.date && a.date.toDate ? a.date.toDate().getTime() : 0;
      const tb = b.date && b.date.toDate ? b.date.toDate().getTime() : 0;
      return tb - ta;
    });

    let totalRev = 0, totalProfit = 0;
    txns.forEach((t) => {
      totalRev += Number(t.total || 0);
      totalProfit += Number(t.profit || 0);
    });

    $('repRev').textContent = money(totalRev);
    $('repProfit').textContent = money(totalProfit);
    $('repCount').textContent = txns.length;
    $('repAvg').textContent = txns.length ? money(totalRev / txns.length) : money(0);

    list.innerHTML = txns.slice(0, 30).map((t) => {
      const dateStr = t.date && t.date.toDate
        ? t.date.toDate().toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
        : '—';
      return `
        <div class="list-item">
          <div class="list-main">
            <div class="list-title">${money(t.total)}</div>
            <div class="list-sub">${esc(dateStr)} · ${Number(t.items || 0)} item${Number(t.items) === 1 ? '' : 's'}</div>
          </div>
          <span class="badge success">+${money(t.profit || 0)}</span>
        </div>`;
    }).join('') || emptyStateHTML('No sales yet', 'Completed sales will appear here.');
  } catch (err) {
    list.innerHTML = emptyStateHTML('Could not load sales', 'Check your internet connection and reopen Reports.');
  }
};

/* ============================================================
   SMALL UX POLISH
   ============================================================ */
$('loginPassword').addEventListener('keydown', (e) => { if (e.key === 'Enter') handleLogin(); });
$('loginEmail').addEventListener('keydown', (e) => { if (e.key === 'Enter') handleLogin(); });
$('scanBarcode').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const first = document.querySelector('#scanResults .result-row');
    if (first) first.click();
  }
});
$('searchName').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const first = document.querySelector('#scanResults .result-row');
    if (first) first.click();
  }
});
$('rQty').addEventListener('change', () => {
  const input = $('rQty');
  const max = parseInt(input.max || '999999', 10);
  let v = parseInt(input.value, 10);
  if (!v || v < 1) v = 1;
  if (v > max) { v = max; showToast(`Only ${max} in stock`, 'info'); }
  input.value = String(v);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('editModal').classList.contains('hidden')) closeEditModal();
});

renderCart();

import { auth, db } from './firebase.js';
import { signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { collection, addDoc, getDocs, serverTimestamp, doc, deleteDoc, updateDoc, increment, getDoc, writeBatch, query, where, Timestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

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

// Retail tabs / returns / day report state
let currentRetailTab = 'sale';
let retailCatTab = 'All';
let returnCtx = null;        // sale being returned (from a receipt)
let returnProduct = null;    // product picked for no-receipt return
let reportDay = new Date();  // selected day for Total Report

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

/* ---------- Shared date helpers ---------- */
const tsMs = (t) => (t && t.toDate ? t.toDate().getTime() : 0);
const fmtTs = (t) => (t && t.toDate
  ? t.toDate().toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  : '—');

function toISODate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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
  if (id === 'retail') {
    loadAllProductsForSearch().then(() => {
      if (currentRetailTab === 'products') renderRetailCatalog();
      if (currentRetailTab === 'returns') loadRecentSales();
    });
  }
};

/* ============================================================
   AUTH
   ============================================================ */
window.togglePassword = function () {
  const input = $('loginPassword');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  $('pwEyeOpen').classList.toggle('hidden', show);
  $('pwEyeClosed').classList.toggle('hidden', !show);
};

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
   RETAIL — tab switching
   ============================================================ */
window.retailTab = function (tab) {
  currentRetailTab = tab;
  ['sale', 'products', 'returns'].forEach((t) => {
    $('retailView-' + t).classList.toggle('hidden', t !== tab);
    $('rtab-' + t).classList.toggle('active', t === tab);
  });
  window.scrollTo({ top: 0 });
  if (tab === 'products') loadAllProductsForSearch().then(renderRetailCatalog);
  if (tab === 'returns') loadRecentSales();
};

/* ============================================================
   RETAIL — search & cart (Sale tab)
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
   CHECKOUT — atomic write with item-level history
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
      units: totalUnits,
      refundTotal: 0,
      // Item-level history — powers returns and the day-wise Total Report
      itemsList: cart.map((item) => ({
        productId: item.id,
        name: item.name,
        qty: item.qty,
        costPrice: item.costPrice,
        unitPrice: item.price,
        lineTotal: item.price * item.qty,
        lineProfit: (item.price - item.costPrice) * item.qty,
        returned: 0
      }))
    });
    for (const item of cart) {
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
   RETAIL — PRODUCTS TAB (view-only catalogue)
   ============================================================ */
window.retailCatTabSet = function (cat) {
  retailCatTab = cat;
  renderRetailCatTabs();
  renderRetailCatalog();
};

function renderRetailCatTabs() {
  const tabsContainer = $('retailCatTabs');
  tabsContainer.innerHTML = CATEGORIES.map((cat) => {
    const isActive = retailCatTab === cat ? 'active' : '';
    return `<button class="cat-tab ${isActive}" onclick="retailCatTabSet('${cat}')">${esc(cat)}</button>`;
  }).join('');
}

window.clearRetailCatalogSearch = function () {
  $('retCatalogSearch').value = '';
  renderRetailCatalog();
};

window.renderRetailCatalog = function () {
  if (!allProductsCache.length) {
    $('retailCatalogList').innerHTML = emptyStateHTML('No products found', 'Products added by the Admin will appear here.');
    $('retailCatalogCount').textContent = '0 Items';
    return;
  }

  const q = $('retCatalogSearch').value.toLowerCase().trim();
  let list = retailCatTab === 'All'
    ? [...allProductsCache]
    : allProductsCache.filter((p) => (p.category || 'Uncategorized') === retailCatTab);

  if (q) {
    list = list.filter((p) =>
      String(p.name || '').toLowerCase().includes(q) ||
      (p.barcode && p.barcode !== 'NO-BARCODE' && String(p.barcode).includes(q))
    );
  }

  list.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));

  $('retailCatalogList').innerHTML = list.length
    ? list.map(retailCardHTML).join('')
    : emptyStateHTML('No matching products', 'Try a different search or category.');

  $('retailCatalogCount').textContent = list.length + (list.length === 1 ? ' Item' : ' Items');
};

function retailCardHTML(p) {
  const cat = p.category || 'Uncategorized';
  const spine = CAT_COLORS[cat] || CAT_COLORS['Uncategorized'];
  const price = Number(p.sellingPrice ?? p.price ?? 0);
  const stock = Number(p.stock || 0);

  const pill = stock <= 0
    ? '<span class="pill out">Out of stock</span>'
    : stock <= LOW_STOCK
      ? `<span class="pill low">Low · ${stock}</span>`
      : `<span class="pill ok">Stock ${stock}</span>`;

  const barcodeText = p.barcode && p.barcode !== 'NO-BARCODE' ? esc(p.barcode) : 'No barcode';

  return `
    <div class="product-card" style="--spine:${spine}" onclick="openViewModal('${esc(p.id)}')">
      <div class="product-info">
        <div class="product-name">${esc(p.name || 'Unnamed product')}</div>
        <div class="product-meta"><span class="cat-dot"></span>${esc(cat)} · ${barcodeText}</div>
      </div>
      <div class="product-right">
        <div class="product-price">${money(price)}</div>
        ${pill}
        <span class="product-arrow">${chevronIcon}</span>
      </div>
    </div>`;
}

/* ---------- View product modal (read-only) ---------- */
window.openViewModal = function (id) {
  const p = allProductsCache.find((x) => x.id === id);
  if (!p) return showToast('Product not found', 'error');

  const price = Number(p.sellingPrice ?? p.price ?? 0);
  const cost = Number(p.costPrice || 0);
  const stock = Number(p.stock || 0);

  $('viewId').value = id;
  $('vName').textContent = p.name || 'Unnamed product';
  $('vMeta').textContent = p.category || 'Uncategorized';
  $('vPrice').textContent = money(price);
  $('vStock').textContent = `${stock} unit${stock === 1 ? '' : 's'}`;
  $('vStock').className = stock <= 0 ? 'cell-danger' : (stock <= LOW_STOCK ? 'cell-warn' : '');
  $('vCost').textContent = money(cost);
  $('vProfit').textContent = money(price - cost);
  $('vBarcode').textContent = p.barcode && p.barcode !== 'NO-BARCODE' ? p.barcode : 'No barcode';

  const addBtn = $('vAddBtn');
  if (stock <= 0) {
    addBtn.disabled = true;
    addBtn.innerHTML = 'Out of Stock';
  } else {
    addBtn.disabled = false;
    addBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg> Add to Sale`;
  }

  $('viewModal').classList.remove('hidden');
  document.body.classList.add('modal-open');
};

window.closeViewModal = function (event) {
  if (event && event.target !== event.currentTarget) return;
  $('viewModal').classList.add('hidden');
  document.body.classList.remove('modal-open');
};

window.addViewToSale = function () {
  const id = $('viewId').value;
  closeViewModal();
  retailTab('sale');
  selectProduct(id);
};

/* ============================================================
   RETURNS — Mode 1: from a sale (with receipt)
   ============================================================ */
window.setReturnMode = function (mode) {
  $('modeSaleBtn').classList.toggle('active', mode === 'sale');
  $('modeProductBtn').classList.toggle('active', mode === 'product');
  $('returnBySale').classList.toggle('hidden', mode !== 'sale');
  $('returnByProduct').classList.toggle('hidden', mode !== 'product');
  if (mode === 'sale') loadRecentSales();
};

async function loadRecentSales() {
  const list = $('recentSalesList');
  list.innerHTML = `<div class="empty-state"><div class="empty-title">Loading sales…</div></div>`;

  try {
    const snap = await getDocs(collection(db, "transactions"));
    const txns = [];
    snap.forEach((d) => { const t = d.data() || {}; txns.push({ id: d.id, ...t }); });
    txns.sort((a, b) => tsMs(b.date) - tsMs(a.date));
    const recent = txns.slice(0, 25);

    if (!recent.length) {
      list.innerHTML = emptyStateHTML('No sales yet', 'Complete a sale first — returns will appear here.');
      return;
    }

    list.innerHTML = recent.map((t) => {
      const refunded = Number(t.refundTotal || 0);
      const fullyRefunded = refunded > 0 && refunded >= Number(t.total || 0) - 0.01;
      const pill = fullyRefunded
        ? '<span class="pill out">Returned</span>'
        : refunded > 0
          ? `<span class="pill low">Refunded ${money(refunded)}</span>`
          : '';
      return `
        <div class="list-item tap-row" onclick="openReturnSale('${esc(t.id)}')">
          <div class="list-main">
            <div class="list-title">${money(t.total)}</div>
            <div class="list-sub">${esc(fmtTs(t.date))} · ${Number(t.items || 0)} item${Number(t.items) === 1 ? '' : 's'}</div>
          </div>
          ${pill}
          <span class="product-arrow">${chevronIcon}</span>
        </div>`;
    }).join('');
  } catch (err) {
    list.innerHTML = emptyStateHTML('Could not load sales', 'Check your internet connection and try again.');
  }
}

window.openReturnSale = async function (saleId) {
  try {
    showToast('Loading sale…', 'info');
    const snap = await getDoc(doc(db, 'transactions', saleId));
    if (!snap.exists()) return showToast('Sale not found', 'error');
    const t = snap.data();

    const hasItemsList = Array.isArray(t.itemsList) && t.itemsList.length > 0;
    let lines;
    if (hasItemsList) {
      lines = t.itemsList.map((it, i) => ({
        key: 'arr-' + i,
        arrIdx: i,
        subId: null,
        productId: it.productId || null,
        name: it.name,
        qty: Number(it.qty || 0),
        unitPrice: Number(it.unitPrice || 0),
        costPrice: Number(it.costPrice || 0),
        returned: Number(it.returned || 0)
      }));
    } else {
      // Older sales — item details live in the lineItems subcollection
      const lineSnap = await getDocs(collection(db, 'transactions', saleId, 'lineItems'));
      lines = lineSnap.docs.map((d) => ({
        key: 'sub-' + d.id,
        arrIdx: -1,
        subId: d.id,
        productId: null,
        name: d.data().name,
        qty: Number(d.data().qty || 0),
        unitPrice: Number(d.data().unitPrice || 0),
        costPrice: Number(d.data().costPrice || 0),
        returned: Number(d.data().returned || 0)
      }));
    }

    if (!lines.length) return showToast('This sale has no item details', 'error');

    returnCtx = { saleId, hasItemsList, lines, rawItemsList: hasItemsList ? t.itemsList : null };
    $('rsMeta').textContent = `${fmtTs(t.date)} · Sale ${money(t.total)}`;
    renderReturnLines();
    $('returnSaleModal').classList.remove('hidden');
    document.body.classList.add('modal-open');
  } catch (err) {
    showToast(err.message, 'error');
  }
};

function renderReturnLines() {
  $('rsLines').innerHTML = returnCtx.lines.map((l) => {
    const remaining = l.qty - l.returned;
    const disabled = remaining <= 0;
    return `
      <div class="return-line">
        <div class="rl-top">
          <div class="rl-main">
            <div class="rl-name">${esc(l.name)}</div>
            <div class="rl-sub">${money(l.unitPrice)} each · sold ${l.qty}${l.returned ? ` · returned ${l.returned}` : ''}</div>
          </div>
          <div class="rl-refund" id="rlr-${l.key}">₹0.00</div>
        </div>
        ${disabled
          ? '<div class="rl-full">Fully returned ✓</div>'
          : `<input type="number" inputmode="numeric" min="0" max="${remaining}" value="0" data-key="${l.key}" oninput="updateReturnTotals()" aria-label="Return quantity for ${esc(l.name)}" />`}
      </div>`;
  }).join('');
  updateReturnTotals();
}

window.updateReturnTotals = function () {
  if (!returnCtx) return;
  let sum = 0, any = false;
  document.querySelectorAll('#rsLines input[data-key]').forEach((inp) => {
    const line = returnCtx.lines.find((l) => l.key === inp.dataset.key);
    if (!line) return;
    const remaining = line.qty - line.returned;
    let q = parseInt(inp.value, 10) || 0;
    if (q > remaining) { q = remaining; inp.value = String(q); }
    if (q < 0) { q = 0; inp.value = '0'; }
    sum += q * line.unitPrice;
    if (q > 0) any = true;
    const badge = $('rlr-' + line.key);
    if (badge) badge.textContent = money(q * line.unitPrice);
  });
  $('rsTotal').textContent = money(sum);
  $('rsConfirmBtn').disabled = !any;
};

window.processSaleReturn = async function () {
  if (!returnCtx) return;
  const picks = [];
  document.querySelectorAll('#rsLines input[data-key]').forEach((inp) => {
    const q = parseInt(inp.value, 10) || 0;
    if (q > 0) {
      const line = returnCtx.lines.find((l) => l.key === inp.dataset.key);
      if (line) picks.push({ line, q });
    }
  });
  if (!picks.length) return showToast('Enter a quantity to return', 'error');

  const refundTotalSum = picks.reduce((s, p) => s + p.line.unitPrice * p.q, 0);

  const btn = $('rsConfirmBtn');
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Processing…';

  try {
    // Check which products still exist (deleted products can't be restocked)
    const uniqueIds = [...new Set(picks.map((p) => p.line.productId).filter(Boolean))];
    const existsMap = {};
    await Promise.all(uniqueIds.map(async (id) => {
      try { existsMap[id] = (await getDoc(doc(db, 'products', id))).exists(); }
      catch (e) { existsMap[id] = false; }
    }));

    let refundSum = 0;
    const batch = writeBatch(db);
    const txnRef = doc(db, 'transactions', returnCtx.saleId);

    if (returnCtx.hasItemsList) {
      const newList = returnCtx.rawItemsList.map((it, i) => {
        const pick = picks.find((p) => p.line.arrIdx === i);
        return pick ? { ...it, returned: Number(it.returned || 0) + pick.q } : it;
      });
      batch.update(txnRef, { itemsList: newList, refundTotal: increment(refundTotalSum), lastReturnAt: serverTimestamp() });
    } else {
      picks.forEach(({ line, q }) => {
        batch.update(doc(db, 'transactions', returnCtx.saleId, 'lineItems', line.subId), { returned: increment(q) });
      });
      batch.update(txnRef, { refundTotal: increment(refundTotalSum), lastReturnAt: serverTimestamp() });
    }

    for (const { line, q } of picks) {
      refundSum += line.unitPrice * q;
      if (line.productId && existsMap[line.productId]) {
        batch.update(doc(db, 'products', line.productId), { stock: increment(q) });
      }
      batch.set(doc(collection(db, 'returns')), {
        date: serverTimestamp(),
        saleId: returnCtx.saleId,
        productId: line.productId || null,
        productName: line.name,
        qty: q,
        unitRefund: line.unitPrice,
        refundTotal: line.unitPrice * q,
        costPrice: line.costPrice
      });
    }

    await batch.commit();
    closeReturnSaleModal();
    buzz();
    showToast(`Return processed · refund ${money(refundSum)} · stock updated`);
    loadAllProductsForSearch();
    loadRecentSales();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
};

window.closeReturnSaleModal = function (event) {
  if (event && event.target !== event.currentTarget) return;
  returnCtx = null;
  $('returnSaleModal').classList.add('hidden');
  document.body.classList.remove('modal-open');
};

/* ============================================================
   RETURNS — Mode 2: without receipt
   ============================================================ */
window.retSearchReturnProduct = function () {
  const q = $('retReturnSearch').value.toLowerCase().trim();
  const box = $('retReturnResults');
  if (!q) { box.classList.add('hidden'); box.innerHTML = ''; return; }

  const matches = allProductsCache.filter((p) =>
    String(p.name || '').toLowerCase().includes(q) ||
    (p.barcode && p.barcode !== 'NO-BARCODE' && String(p.barcode).includes(q))
  );

  box.innerHTML = matches.slice(0, 12).map((p) => {
    const price = Number(p.sellingPrice ?? p.price ?? 0);
    return `
      <div class="result-row" onclick="pickReturnProduct('${esc(p.id)}')">
        <div>
          <div class="result-name">${esc(p.name || 'Unnamed product')}</div>
          <div class="result-sub">${esc(p.category || '')} · sells at ${money(price)}</div>
        </div>
        <div class="result-price">${money(price)}</div>
      </div>`;
  }).join('') || '<div class="no-results">No matching products found</div>';
  box.classList.remove('hidden');
};

window.clearReturnSearch = function () {
  $('retReturnSearch').value = '';
  $('retReturnResults').classList.add('hidden');
  $('retReturnResults').innerHTML = '';
  $('retReturnSearch').focus();
};

window.pickReturnProduct = function (id) {
  const p = allProductsCache.find((x) => x.id === id);
  if (!p) return showToast('Product not found', 'error');

  returnProduct = p;
  const price = Number(p.sellingPrice ?? p.price ?? 0);
  $('retReturnResults').classList.add('hidden');
  $('retReturnResults').innerHTML = '';
  $('retReturnSearch').value = p.name || '';
  $('nrName').textContent = p.name || 'Unnamed product';
  $('nrMeta').textContent = `${p.category || 'Uncategorized'} · sells at ${money(price)}`;
  $('nrQty').value = '1';
  $('nrRefund').value = String(price);
  updateNoReceiptTotal();
  $('noReceiptForm').classList.remove('hidden');
};

window.updateNoReceiptTotal = function () {
  const qty = parseInt($('nrQty').value, 10) || 0;
  const refund = parseFloat($('nrRefund').value) || 0;
  $('nrTotal').textContent = money(qty * refund);
};

window.clearNoReceiptForm = function () {
  returnProduct = null;
  $('retReturnSearch').value = '';
  $('noReceiptForm').classList.add('hidden');
};

window.processNoReceiptReturn = async function () {
  if (!returnProduct) return showToast('Pick a product first', 'error');
  const qty = parseInt($('nrQty').value, 10);
  const refund = parseFloat($('nrRefund').value);
  if (!qty || qty < 1) return showToast('Enter a valid return quantity', 'error');
  if (isNaN(refund) || refund < 0) return showToast('Enter a valid refund amount', 'error');

  const btn = $('nrConfirmBtn');
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Processing…';

  try {
    // Fresh read: product may have been renamed / re-priced / deleted
    const pSnap = await getDoc(doc(db, 'products', returnProduct.id));
    if (!pSnap.exists()) {
      showToast('This product no longer exists', 'error');
      return;
    }
    const p = pSnap.data();
    const costPrice = Number(p.costPrice || 0);

    const batch = writeBatch(db);
    batch.update(doc(db, 'products', returnProduct.id), { stock: increment(qty) });
    batch.set(doc(collection(db, 'returns')), {
      date: serverTimestamp(),
      saleId: null,
      productId: returnProduct.id,
      productName: p.name || returnProduct.name,
      qty,
      unitRefund: refund,
      refundTotal: refund * qty,
      costPrice
    });
    await batch.commit();

    buzz();
    showToast(`Return saved · refund ${money(refund * qty)} · stock updated`);
    clearNoReceiptForm();
    loadAllProductsForSearch();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
};

/* ============================================================
   REPORTS — all-time (net of returns)
   ============================================================ */
window.loadReports = async function () {
  const list = $('txnList');
  const retList = $('returnTxnList');
  list.innerHTML = `<div class="empty-state"><div class="empty-title">Loading sales…</div></div>`;
  retList.innerHTML = '';

  try {
    const [txnSnap, retSnap] = await Promise.all([
      getDocs(collection(db, "transactions")),
      getDocs(collection(db, "returns"))
    ]);

    const txns = [];
    txnSnap.forEach((d) => { const t = d.data() || {}; txns.push({ id: d.id, ...t }); });
    txns.sort((a, b) => tsMs(b.date) - tsMs(a.date));

    const returns = [];
    retSnap.forEach((d) => { const r = d.data() || {}; returns.push({ id: d.id, ...r }); });
    returns.sort((a, b) => tsMs(b.date) - tsMs(a.date));

    let totalRev = 0, totalProfit = 0;
    txns.forEach((t) => {
      totalRev += Number(t.total || 0);
      totalProfit += Number(t.profit || 0);
    });

    let retRefund = 0, retCost = 0;
    returns.forEach((r) => {
      retRefund += Number(r.refundTotal || 0);
      retCost += Number(r.costPrice || 0) * Number(r.qty || 0);
    });

    const netCollected = totalRev - retRefund;
    const netProfit = totalProfit - (retRefund - retCost);

    $('repRev').textContent = money(netCollected);
    $('repProfit').textContent = money(netProfit);
    $('repCount').textContent = txns.length;
    $('repAvg').textContent = txns.length ? money(totalRev / txns.length) : money(0);
    $('repNote').textContent = `Gross sales ${money(totalRev)} · Returns ${money(retRefund)}`;

    list.innerHTML = txns.slice(0, 30).map((t) => {
      const refunded = Number(t.refundTotal || 0);
      return `
        <div class="list-item">
          <div class="list-main">
            <div class="list-title">${money(t.total)}</div>
            <div class="list-sub">${esc(fmtTs(t.date))} · ${Number(t.items || 0)} item${Number(t.items) === 1 ? '' : 's'}${refunded > 0 ? ` · refunded ${money(refunded)}` : ''}</div>
          </div>
          <span class="badge success">+${money(t.profit || 0)}</span>
        </div>`;
    }).join('') || emptyStateHTML('No sales yet', 'Completed sales will appear here.');

    retList.innerHTML = returns.slice(0, 10).map((r) => `
      <div class="list-item">
        <div class="list-main">
          <div class="list-title">${esc(r.productName || 'Product')}</div>
          <div class="list-sub">${esc(fmtTs(r.date))} · ${Number(r.qty || 0)} unit${Number(r.qty) === 1 ? '' : 's'} · ${r.saleId ? 'With receipt' : 'No receipt'}</div>
        </div>
        <span class="badge danger">-${money(r.refundTotal || 0)}</span>
      </div>`).join('') || emptyStateHTML('No returns yet', 'Customer returns will appear here.');
  } catch (err) {
    list.innerHTML = emptyStateHTML('Could not load reports', 'Check your internet connection and reopen Reports.');
    retList.innerHTML = '';
  }
};

/* ============================================================
   TOTAL REPORT — day wise (sales, returns, stock, profit)
   ============================================================ */
window.openDayReport = async function () {
  reportDay = new Date();
  reportDay.setHours(0, 0, 0, 0);
  $('reportDate').value = toISODate(reportDay);
  $('reportModal').classList.remove('hidden');
  document.body.classList.add('modal-open');
  loadAllProductsForSearch(); // refresh stock in background
  await renderDayReport();
};

window.closeDayReport = function (event) {
  if (event && event.target !== event.currentTarget) return;
  $('reportModal').classList.add('hidden');
  document.body.classList.remove('modal-open');
};

window.changeDay = function (offset) {
  reportDay.setDate(reportDay.getDate() + offset);
  $('reportDate').value = toISODate(reportDay);
  renderDayReport();
};

window.onReportDateChange = function () {
  const v = $('reportDate').value;
  if (!v) return;
  reportDay = new Date(v + 'T00:00:00');
  renderDayReport();
};

window.renderDayReport = async function () {
  const tableBody = $('drTableBody');
  const returnsList = $('drReturnsList');
  tableBody.innerHTML = `<tr><td colspan="6" class="no-results">Loading…</td></tr>`;
  returnsList.innerHTML = '';

  const start = new Date(reportDay);
  const end = new Date(reportDay);
  end.setDate(end.getDate() + 1);

  const todayMid = new Date();
  todayMid.setHours(0, 0, 0, 0);
  $('nextDayBtn').disabled = reportDay.getTime() >= todayMid.getTime();

  try {
    const [txnSnap, retSnap, prodSnap] = await Promise.all([
      getDocs(query(
        collection(db, 'transactions'),
        where('date', '>=', Timestamp.fromDate(start)),
        where('date', '<', Timestamp.fromDate(end))
      )),
      getDocs(query(
        collection(db, 'returns'),
        where('date', '>=', Timestamp.fromDate(start)),
        where('date', '<', Timestamp.fromDate(end))
      )),
      getDocs(collection(db, 'products'))
    ]);

    // Live stock lookup (by id, fallback by name for very old data)
    const stockById = new Map();
    const stockByName = new Map();
    prodSnap.forEach((d) => {
      const p = d.data() || {};
      stockById.set(d.id, Number(p.stock || 0));
      if (p.name) stockByName.set(String(p.name), Number(p.stock || 0));
    });

    // Collect transactions; for old sales fetch their lineItems subcollection
    const txns = [];
    txnSnap.forEach((d) => { const t = d.data() || {}; txns.push({ id: d.id, ...t }); });
    await Promise.all(txns
      .filter((t) => !Array.isArray(t.itemsList) || !t.itemsList.length)
      .map(async (t) => {
        try {
          const ls = await getDocs(collection(db, 'transactions', t.id, 'lineItems'));
          t._lines = ls.docs.map((d) => ({
            productId: null,
            name: d.data().name,
            qty: Number(d.data().qty || 0),
            unitPrice: Number(d.data().unitPrice || 0),
            costPrice: Number(d.data().costPrice || 0),
            lineTotal: Number(d.data().lineTotal || 0),
            lineProfit: Number(d.data().lineProfit || 0)
          }));
        } catch (e) { t._lines = []; }
      }));

    // Aggregate per product
    const byProduct = new Map();
    const keyFor = (id, name) => id || 'n:' + String(name || '').toLowerCase();
    let gross = 0, salesProfit = 0, units = 0;

    for (const t of txns) {
      gross += Number(t.total || 0);
      salesProfit += Number(t.profit || 0);

      const lines = Array.isArray(t.itemsList) && t.itemsList.length
        ? t.itemsList.map((it) => ({
            productId: it.productId || null,
            name: it.name,
            qty: Number(it.qty || 0),
            unitPrice: Number(it.unitPrice || 0),
            costPrice: Number(it.costPrice || 0),
            lineTotal: Number(it.lineTotal || 0) || Number(it.unitPrice || 0) * Number(it.qty || 0),
            lineProfit: Number(it.lineProfit || 0) || (Number(it.unitPrice || 0) - Number(it.costPrice || 0)) * Number(it.qty || 0)
          }))
        : (t._lines || []);

      for (const l of lines) {
        const key = keyFor(l.productId, l.name);
        if (!byProduct.has(key)) {
          byProduct.set(key, { name: l.name || 'Unnamed product', productId: l.productId, sold: 0, revenue: 0, profit: 0, returned: 0, refund: 0 });
        }
        const e = byProduct.get(key);
        e.sold += l.qty;
        e.revenue += l.lineTotal;
        e.profit += l.lineProfit;
        units += l.qty;
      }
    }

    // Returns of the day
    const dayReturns = [];
    retSnap.forEach((d) => { const r = d.data() || {}; dayReturns.push({ id: d.id, ...r }); });
    let retRefund = 0, retCost = 0;
    for (const r of dayReturns) {
      retRefund += Number(r.refundTotal || 0);
      retCost += Number(r.costPrice || 0) * Number(r.qty || 0);
      const key = keyFor(r.productId, r.productName);
      if (!byProduct.has(key)) {
        byProduct.set(key, { name: r.productName || 'Returned item', productId: r.productId, sold: 0, revenue: 0, profit: 0, returned: 0, refund: 0 });
      }
      const e = byProduct.get(key);
      e.returned += Number(r.qty || 0);
      e.refund += Number(r.refundTotal || 0);
    }

    const collected = gross - retRefund;
    const netProfit = salesProfit - (retRefund - retCost);

    $('drCollected').textContent = money(collected);
    $('drGross').textContent = money(gross);
    $('drReturns').textContent = money(retRefund);
    $('drCount').textContent = txns.length;
    $('drUnits').textContent = units;
    $('drProfit').textContent = money(netProfit);

    const rows = [...byProduct.values()].sort((a, b) => b.revenue - a.revenue || b.sold - a.sold);
    tableBody.innerHTML = rows.map((e) => {
      let stock = null;
      if (e.productId && stockById.has(e.productId)) stock = stockById.get(e.productId);
      else if (stockByName.has(String(e.name))) stock = stockByName.get(String(e.name));
      const stockCell = stock === null
        ? '<span class="cell-muted">—</span>'
        : (stock <= 0 ? '<span class="cell-danger">0</span>' : stock);
      return `
        <tr>
          <td class="p-name">${esc(e.name)}</td>
          <td class="num">${e.sold || '—'}</td>
          <td class="num">${e.returned || '—'}</td>
          <td class="num">${stockCell}</td>
          <td class="num">${money(e.revenue)}</td>
          <td class="num">${money(e.profit)}</td>
        </tr>`;
    }).join('') || `<tr><td colspan="6" class="no-results">No sales on this day</td></tr>`;

    returnsList.innerHTML = dayReturns.length
      ? dayReturns.map((r) => `
          <div class="list-item">
            <div class="list-main">
              <div class="list-title">${esc(r.productName || 'Product')}</div>
              <div class="list-sub">${Number(r.qty || 0)} × ${money(r.unitRefund || 0)} · ${r.saleId ? 'With receipt' : 'No receipt'}</div>
            </div>
            <span class="badge danger">-${money(r.refundTotal || 0)}</span>
          </div>`).join('')
      : emptyStateHTML('No returns on this day', '');
  } catch (err) {
    tableBody.innerHTML = `<tr><td colspan="6" class="no-results">Could not load report — check your internet connection</td></tr>`;
    returnsList.innerHTML = '';
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
  if (e.key !== 'Escape') return;
  if (!$('editModal').classList.contains('hidden')) closeEditModal();
  if (!$('viewModal').classList.contains('hidden')) closeViewModal();
  if (!$('returnSaleModal').classList.contains('hidden')) closeReturnSaleModal();
  if (!$('reportModal').classList.contains('hidden')) closeDayReport();
});

renderCart();

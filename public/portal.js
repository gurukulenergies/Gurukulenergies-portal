/**
 * GURUKUL ENERGIES - PUBLIC TENANT PORTAL
 * The browser only ever receives ONE bill, fetched by the 5-digit bill code.
 * There is no bulk ledger download and no bill list on the public site.
 */
/**
 * GURUKUL ENERGIES PRIVATE LIMITED - TENANT BILL LOOKUP & PAYMENT ENGINE
 * Search bill details by last 5 digits of bill number, view breakdown & pay via UPI
 */

// Standalone ISO/IEC 18004 Standard QR Code Engine for Tenant Portal
const QRCodeEngine = (function () {
  return {
    drawOnCanvas: function (canvas, text, pxSize) {
      if (!canvas) return;
      pxSize = pxSize || 170;
      const scale = 2;
      const totalPx = pxSize * scale;

      canvas.width = totalPx;
      canvas.height = totalPx;
      canvas.style.width = pxSize + 'px';
      canvas.style.height = pxSize + 'px';

      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, totalPx, totalPx);

      if (typeof window !== 'undefined' && window.QRCode) {
        try {
          const tempDiv = document.createElement('div');
          tempDiv.style.cssText = 'position: absolute; left: -9999px; top: -9999px; width: 0; height: 0; overflow: hidden;';
          document.body.appendChild(tempDiv);

          new window.QRCode(tempDiv, {
            text: text,
            width: totalPx,
            height: totalPx,
            colorDark: '#000000',
            colorLight: '#FFFFFF',
            correctLevel: window.QRCode.CorrectLevel.M
          });

          const copyFromElement = (source) => {
            ctx.fillStyle = '#FFFFFF';
            ctx.fillRect(0, 0, totalPx, totalPx);
            const margin = Math.round(totalPx * 0.06);
            const drawSize = totalPx - margin * 2;
            ctx.drawImage(source, margin, margin, drawSize, drawSize);
            tempDiv.remove();
          };

          const qCanvas = tempDiv.querySelector('canvas');
          const qImg = tempDiv.querySelector('img');

          if (qCanvas) {
            copyFromElement(qCanvas);
            return;
          } else if (qImg && qImg.complete && qImg.naturalWidth > 0) {
            copyFromElement(qImg);
            return;
          } else if (qImg) {
            qImg.onload = () => copyFromElement(qImg);
            return;
          }
        } catch (e) {
          console.warn("window.QRCode failed, using fallback:", e);
        }
      }

      // API Fallback
      try {
        const fallbackUrl = `https://api.qrserver.com/v1/create-qr-code/?size=${totalPx}x${totalPx}&data=${encodeURIComponent(text)}&margin=2`;
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          ctx.fillStyle = '#FFFFFF';
          ctx.fillRect(0, 0, totalPx, totalPx);
          ctx.drawImage(img, 0, 0, totalPx, totalPx);
        };
        img.src = fallbackUrl;
      } catch (err) {
        console.error("All QR engines failed:", err);
      }
    }
  };
})();


// Main Portal Application
document.addEventListener('DOMContentLoaded', () => {
  // DOM Elements
  const inpBillCode = document.getElementById('inpBillCode');
  const btnSearch = document.getElementById('btnSearch');
  const billResultCard = document.getElementById('billResultCard');
  const notFoundCard = document.getElementById('notFoundCard');
  const notFoundQueryText = document.getElementById('notFoundQueryText');
  const btnPrintPortalSlip = document.getElementById('btnPrintPortalSlip');


  let busy = false;
  let currentBill = null;
  let payConfig = { payments: false, keyId: null };
  const configReady = fetch('/api/config', { cache: 'no-store' }).then(r => r.json()).then(c => { payConfig = c || payConfig; }).catch(() => {});

  async function performSearch() {
    if (busy) return;
    const raw = (inpBillCode ? inpBillCode.value : '').trim();
    const code = raw.replace(/[^0-9A-Za-z]/g, '').slice(-5);
    if (!/^[0-9A-Za-z]{5}$/.test(code)) {
      alert("Please enter the last 5 digits of your bill number.");
      if (inpBillCode) inpBillCode.focus();
      return;
    }
    busy = true;
    if (btnSearch) btnSearch.disabled = true;
    try {
      await configReady;
      const res = await fetch('/api/bill?code=' + encodeURIComponent(code), { cache: 'no-store' });
      if (res.status === 429) {
        alert("Too many attempts. Please wait a few minutes and try again.");
      } else if (res.ok) {
        const data = await res.json();
        if (data && data.bill) { currentBill = data.bill; renderBillDetails(data.bill); return; }
        showNotFound(code);
      } else {
        showNotFound(code);
      }
    } catch (e) {
      alert("Could not reach the server. Please check your internet connection and try again.");
    } finally {
      busy = false;
      if (btnSearch) btnSearch.disabled = false;
    }
  }

  function renderBillDetails(bill) {
    if (notFoundCard) notFoundCard.classList.remove('active');
    if (!billResultCard) return;

    const isPaid = (bill.status || '').toUpperCase() === 'PAID';
    const billNo = bill.billNo || 'GE/2026/09/84920';
    const last5 = bill.last5Digits || billNo.slice(-5);
    const amountVal = parseFloat(bill.amount) || 0;
    const unitsVal = parseInt(bill.units, 10) || 0;
    const accId = bill.accountID || 'LH1';
    const upiVpa = bill.upiId || 'Sunil6434@ybl';
    const payee = bill.payeeName || 'GURUKUL ENERGIES PVT LTD';

    // Status Banner
    const statusBanner = document.getElementById('resStatusBanner');
    const statusPill = document.getElementById('resStatusPill');
    const dueNotice = document.getElementById('resDueNotice');

    if (statusBanner && statusPill && dueNotice) {
      if (isPaid) {
        statusBanner.className = 'status-banner paid';
        statusPill.className = 'status-pill paid';
        statusPill.innerHTML = '🟢 PAID IN FULL';
        dueNotice.className = 'due-notice paid';
        dueNotice.innerHTML = `✅ Payment Confirmed (${bill.txnID || 'UPI CLEARED'})`;
      } else {
        statusBanner.className = 'status-banner unpaid';
        statusPill.className = 'status-pill unpaid';
        statusPill.innerHTML = '🔴 PAYMENT PENDING (UNPAID)';
        dueNotice.className = 'due-notice unpaid';
        dueNotice.innerHTML = `⚠️ Payment Due on or before <strong>${formatDateDisplay(bill.dueDate || '2026-09-24')}</strong>`;
      }
    }

    // Header Meta
    setText('resBillNo', billNo);
    setText('resBillCodePill', `#${last5}`);
    setText('resBillDate', formatDateDisplay(bill.billDate || '2026-09-10'));
    setText('resDueDate', formatDateDisplay(bill.dueDate || '2026-09-24'));

    // Tenant & Connection Info
    setText('resAccountID', accId);
    setText('resConsumerName', bill.consumerName || `House ${accId}`);
    setText('resMeterSerial', bill.rrNo || '1068634');
    setText('resAddress', bill.address || `Quarter ${accId}, Gurukul Energies Campus`);
    setText('resTariff', `Solar ₹${(bill.solarRate || 5.80).toFixed(2)} + Inv ₹${(bill.inverterRate || 1.20).toFixed(2)} / kWh`);
    setText('resSancLoad', `${(bill.sancLoad || 1.0).toFixed(1)} KW`);

    // Meter Readings
    const prevR = parseFloat(bill.prevReading) || 14200;
    const presR = parseFloat(bill.presReading) || (prevR + unitsVal);
    setText('resPrevReading', `${prevR.toLocaleString()} kWh`);
    setText('resPresReading', `${presR.toLocaleString()} kWh`);
    setText('resUnitsBilled', `${unitsVal} kWh`);

    // Charges Table
    const fixedChg = parseFloat(bill.fixedCharges) || 150;
    const solarChg = parseFloat(bill.solarCharges) || Math.round(unitsVal * (bill.solarRate || 5.80));
    const invChg = parseFloat(bill.inverterCharges) || Math.round(unitsVal * (bill.inverterRate || 1.20));
    const maintChg = parseFloat(bill.maintenance) || 0;
    const taxChg = parseFloat(bill.taxAmount) || 0;
    const rebateChg = parseFloat(bill.rebate) || 10;

    setText('resFixedChg', formatCurrency(fixedChg));
    setText('resSolarRateLabel', `↳ Solar Energy (${unitsVal} kWh @ ₹${(bill.solarRate || 5.80).toFixed(2)})`);
    setText('resSolarChg', formatCurrency(solarChg));
    setText('resInvRateLabel', `↳ Inverter Energy (${unitsVal} kWh @ ₹${(bill.inverterRate || 1.20).toFixed(2)})`);
    setText('resInvChg', formatCurrency(invChg));
    setText('resMaintChg', formatCurrency(maintChg));
    setText('resTaxChg', formatCurrency(taxChg));
    setText('resRebateChg', `- ${formatCurrency(rebateChg)}`);
    setText('resNetPayable', formatCurrency(amountVal));

    // Payment Section Toggle (UNPAID QR vs PAID Stamp)
    const unpaidSection = document.getElementById('resUnpaidSection');
    const paidSection = document.getElementById('resPaidSection');

    if (isPaid) {
      if (unpaidSection) unpaidSection.style.display = 'none';
      if (paidSection) paidSection.style.display = 'block';

      setText('resPaidTxn', bill.txnID || 'UPI/482910492019');
      setText('resPaidMethod', bill.payMode || 'PhonePe / UPI');
      setText('resPaidDate', bill.paidDate || '12-09-2026 11:30 AM');
      setText('resPaidPayee', upiVpa);
    } else {
      if (paidSection) paidSection.style.display = 'none';
      if (unpaidSection) unpaidSection.style.display = 'block';

      const gwBox = document.getElementById('gatewayPayBox');
      const legacy = document.getElementById('legacyQrFlex');
      const online = !!payConfig.payments;
      if (gwBox) gwBox.style.display = online ? 'flex' : 'none';
      if (legacy) legacy.style.display = online ? 'none' : '';
      setText('gwAmount', formatCurrency(amountVal));
      setText('gwMsg', '');
      setText('resQrAmount', formatCurrency(amountVal));
      setText('resQrVpa', upiVpa);
      setText('resQrPayee', payee);

      // Render Dynamic UPI QR Code
      const canvas = document.getElementById('resQrCanvas');
      if (canvas) {
        const upiPayload = `upi://pay?pa=${encodeURIComponent(upiVpa)}&pn=${encodeURIComponent(payee)}&am=${amountVal.toFixed(2)}&cu=INR&tn=GE-Bill-${accId}`;
        QRCodeEngine.drawOnCanvas(canvas, upiPayload, 170);

        // Mobile 1-Tap Pay Deep Link
        const btnUpiMobile = document.getElementById('btnUpiMobile');
        if (btnUpiMobile) {
          btnUpiMobile.href = upiPayload;
        }
      }
    }

    billResultCard.classList.add('active');
    billResultCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function showNotFound(query) {
    if (billResultCard) billResultCard.classList.remove('active');
    if (notFoundCard) {
      if (notFoundQueryText) notFoundQueryText.textContent = query;
      notFoundCard.classList.add('active');
      notFoundCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  async function refreshCurrentBill() {
    if (!currentBill) return;
    const code = String(currentBill.last5Digits || currentBill.billNo || '').replace(/[^0-9A-Za-z]/g, '').slice(-5);
    try {
      const res = await fetch('/api/bill?code=' + encodeURIComponent(code), { cache: 'no-store' });
      if (res.ok) { const d = await res.json(); if (d && d.bill) { currentBill = d.bill; renderBillDetails(d.bill); return true; } }
    } catch (e) {}
    return false;
  }

  async function startOnlinePayment() {
    const btn = document.getElementById('btnPayOnline');
    const msg = (t) => setText('gwMsg', t);
    if (!currentBill) return;
    if (typeof window.Razorpay === 'undefined') { msg('Payment window is still loading. Please try again in a moment.'); return; }
    const code = String(currentBill.last5Digits || currentBill.billNo || '').replace(/[^0-9A-Za-z]/g, '').slice(-5);
    btn.disabled = true; msg('Starting secure payment...');
    try {
      const res = await fetch('/api/pay/order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
      const o = await res.json();
      if (res.status === 409) { msg('This bill is already paid.'); await refreshCurrentBill(); return; }
      if (!res.ok) { msg(o.error || 'Could not start payment.'); return; }
      const rz = new window.Razorpay({
        key: o.keyId, order_id: o.orderId, amount: o.amount, currency: o.currency,
        name: 'Gurukul Energies', description: 'Electricity bill ' + o.billNo,
        theme: { color: '#0B3C5D' },
        handler: async function (resp) {
          msg('Payment received. Confirming...');
          try {
            const v = await fetch('/api/pay/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(resp) });
            const vj = await v.json();
            if (v.ok && vj.success) { await refreshCurrentBill(); return; }
            msg(vj.error || 'Payment is being confirmed. Please check again in a minute.');
          } catch (e) { msg('Payment is being confirmed. Please check again in a minute.'); }
        },
        modal: { ondismiss: function () { btn.disabled = false; if (!document.getElementById('gwMsg').textContent.startsWith('Payment')) msg(''); } }
      });
      rz.on('payment.failed', function (r) { msg((r && r.error && r.error.description) || 'Payment failed. You can try again.'); btn.disabled = false; });
      rz.open();
    } catch (e) {
      msg('Network problem. Please try again.');
    } finally {
      setTimeout(() => { btn.disabled = false; }, 1500);
    }
  }
  const btnPayOnline = document.getElementById('btnPayOnline');
  if (btnPayOnline) btnPayOnline.addEventListener('click', startOnlinePayment);

  // Event Listeners
  if (btnSearch) btnSearch.addEventListener('click', performSearch);
  if (inpBillCode) {
    inpBillCode.addEventListener('keyup', (e) => { if (e.key === 'Enter') performSearch(); });
  }
  if (btnPrintPortalSlip) btnPrintPortalSlip.addEventListener('click', () => window.print());

  // Deep link: /?code=84920 (e.g. from a QR code or WhatsApp message)
  const qp = new URLSearchParams(window.location.search).get('code');
  if (qp && inpBillCode) { inpBillCode.value = qp; performSearch(); }

  // Utilities
  function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  }

  function formatCurrency(val) {
    return '₹ ' + (parseFloat(val) || 0).toLocaleString('en-IN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  function formatDateDisplay(dStr) {
    if (!dStr) return '';
    const d = new Date(dStr);
    if (isNaN(d.getTime())) return dStr;
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return `${day}-${month}-${year}`;
  }

});

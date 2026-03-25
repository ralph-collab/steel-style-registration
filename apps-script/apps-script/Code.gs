/***************************************
 * Steel & Style Registration System
 * Google Apps Script - Code.gs
 *
 * GitHub-safe version:
 * - No hard-coded secrets
 * - Reads Square + admin email values from Script Properties
 ***************************************/

const CONFIG = {
  SHEET_NAME: "2026 Registration",
  MAX_VEHICLES: 10,
  PAYMENT_STATUS_DEFAULT: "Awaiting Square Payment",
  FORM_STATUS_DEFAULT: "Submitted",
  PAYMENT_STATUS_OPTIONS: [
    "Awaiting Square Payment",
    "Paid",
    "Manual Payment",
    "Cancelled",
    "Refunded"
  ],
  CURRENCY: "USD",
  SQUARE_API_BASE: "https://connect.squareup.com",
  SQUARE_API_VERSION: "2026-01-22",
  EVENT_NAME: "Steel & Style 2026",
  EVENT_LOCATION: "Historic Broadwater",
  EVENT_ADDRESS: "1016 Williams St, Helena, MT 59601",
  ADMIN_EMAIL_SUBJECT_TAG: "[SteelStyleAdmin]"
};

function doGet() {
  return ContentService
    .createTextOutput("Steel & Style registration web app is running.")
    .setMimeType(ContentService.MimeType.TEXT);
}

function doPost(e) {
  try {
    if (isJsonWebhook_(e)) {
      return handleSquareWebhook_(e);
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = getOrCreateSheet_(ss, CONFIG.SHEET_NAME);

    ensureHeaders_(sheet);
    ensurePaymentStatusValidation_(sheet);

    const data = parseIncomingData_(e);
    const headerMap = getHeaderMap_(sheet);

    const regId = createRegistrationId_();
    const vehicleCount = determineVehicleCount_(data);
    const vehicleIds = buildVehicleIds_(regId, vehicleCount);
    const paymentInfo = buildPaymentInfo_(vehicleCount);

    const squareCheckout = createSquarePaymentLink_(regId, data, paymentInfo);

    const row = buildRowFromHeaders_(
      sheet,
      headerMap,
      data,
      regId,
      vehicleIds,
      vehicleCount,
      paymentInfo,
      squareCheckout
    );

    sheet.appendRow(row);
    ensurePaymentStatusValidation_(sheet);

    const lastRow = sheet.getLastRow();
    maybeSendRegistrationConfirmationEmail_(sheet, lastRow);

    return jsonResponse_({
      success: true,
      regId: regId,
      vehicleCount: vehicleCount,
      vehicleIds: vehicleIds,
      registrationType: paymentInfo.type,
      amount: paymentInfo.amountDisplay,
      paymentLink: squareCheckout.url,
      paymentLinkId: squareCheckout.paymentLinkId,
      orderId: squareCheckout.orderId,
      message: "Registration saved"
    });
  } catch (err) {
    return jsonResponse_({
      success: false,
      error: String(err),
      stack: err && err.stack ? err.stack : ""
    });
  }
}

function isJsonWebhook_(e) {
  return !!(
    e &&
    e.postData &&
    e.postData.contents &&
    e.postData.type &&
    String(e.postData.type).toLowerCase().indexOf("application/json") !== -1
  );
}

function handleSquareWebhook_(e) {
  try {
    const payload = JSON.parse(e.postData.contents || "{}");
    const eventType = payload.type || "";
    const payment = payload.data && payload.data.object && payload.data.object.payment
      ? payload.data.object.payment
      : null;

    if (!payment) {
      return jsonResponse_({ success: true, ignored: true, reason: "No payment object" });
    }

    const paymentStatus = payment.status || "";
    if (paymentStatus !== "COMPLETED") {
      return jsonResponse_({
        success: true,
        ignored: true,
        reason: "Payment not completed",
        eventType: eventType,
        status: paymentStatus
      });
    }

    const orderId = payment.order_id || "";
    const paymentId = payment.id || "";
    const paidAt = payment.updated_at || payment.created_at || new Date().toISOString();

    if (!orderId) {
      return jsonResponse_({
        success: false,
        message: "Completed payment missing order_id"
      });
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
    if (!sheet) {
      return jsonResponse_({ success: false, message: "Registration sheet not found" });
    }

    const values = sheet.getDataRange().getValues();
    if (values.length < 2) {
      return jsonResponse_({ success: false, message: "No data rows found" });
    }

    const headers = values[0];
    const orderCol = headers.indexOf("Square Order ID");
    const paymentStatusCol = headers.indexOf("Payment Status");
    const paymentTypeCol = headers.indexOf("Payment Type");
    const paidAtCol = headers.indexOf("Paid At");
    const paymentIdCol = headers.indexOf("Square Payment ID");
    const paidTimestampCol = headers.indexOf("Paid Timestamp");

    if ([orderCol, paymentStatusCol, paidAtCol, paymentIdCol, paidTimestampCol].some(i => i === -1)) {
      return jsonResponse_({ success: false, message: "Required columns missing" });
    }

    for (let r = 1; r < values.length; r++) {
      if (String(values[r][orderCol]) === String(orderId)) {
        sheet.getRange(r + 1, paymentStatusCol + 1).setValue("Paid");
        sheet.getRange(r + 1, paidAtCol + 1).setValue(paidAt);
        sheet.getRange(r + 1, paymentIdCol + 1).setValue(paymentId);
        sheet.getRange(r + 1, paidTimestampCol + 1).setValue(new Date());

        if (paymentTypeCol !== -1) {
          const amount = payment.amount_money ? Number(payment.amount_money.amount || 0) : 0;
          const paymentType = amount === 0 ? "Test Coupon" : "Paid";
          sheet.getRange(r + 1, paymentTypeCol + 1).setValue(paymentType);
        }

        maybeSendPaymentConfirmationEmail_(sheet, r + 1);

        return jsonResponse_({
          success: true,
          matched: true,
          orderId: orderId,
          paymentId: paymentId
        });
      }
    }

    return jsonResponse_({
      success: false,
      matched: false,
      message: "No registration row matched order_id",
      orderId: orderId
    });
  } catch (err) {
    return jsonResponse_({
      success: false,
      error: String(err),
      stack: err && err.stack ? err.stack : ""
    });
  }
}

function getOrCreateSheet_(ss, sheetName) {
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) sheet = ss.insertSheet(sheetName);
  return sheet;
}

function ensureHeaders_(sheet) {
  const existingHeaders = getHeaders_(sheet);
  const requiredHeaders = buildRequiredHeaders_();

  if (existingHeaders.length === 0) {
    sheet.getRange(1, 1, 1, requiredHeaders.length).setValues([requiredHeaders]);
    return;
  }

  const missingHeaders = requiredHeaders.filter(h => !existingHeaders.includes(h));
  if (missingHeaders.length > 0) {
    const startCol = existingHeaders.length + 1;
    sheet.getRange(1, startCol, 1, missingHeaders.length).setValues([missingHeaders]);
  }
}

function buildRequiredHeaders_() {
  const headers = [
    "Timestamp",
    "Reg ID",
    "First Name",
    "Last Name",
    "Address",
    "City",
    "State",
    "Zip",
    "Email",
    "Phone",
    "Car Club"
  ];

  for (let i = 1; i <= CONFIG.MAX_VEHICLES; i++) {
    headers.push(`Vehicle ${i} Year`);
    headers.push(`Vehicle ${i} Make`);
    headers.push(`Vehicle ${i} Model`);
    headers.push(`Vehicle ${i} Color`);
  }

  headers.push("Registration Type");
  headers.push("Amount");
  headers.push("Waiver Agreed");
  headers.push("Signature");
  headers.push("Date Signed");
  headers.push("Form Status");
  headers.push("Payment Status");
  headers.push("Payment Type");
  headers.push("Square Order ID");
  headers.push("Square Payment Link URL");
  headers.push("Square Payment Link ID");
  headers.push("Paid At");
  headers.push("Square Payment ID");
  headers.push("Notes");

  for (let i = 1; i <= CONFIG.MAX_VEHICLES; i++) {
    headers.push(`Vehicle ${i} ID`);
  }

  headers.push("Vehicle Count");
  headers.push("Registration Total");
  headers.push("Payment Link");
  headers.push("Paid Timestamp");
  headers.push("Confirmation Email Sent");
  headers.push("Confirmation Email Sent At");
  headers.push("Payment Email Sent");
  headers.push("Payment Email Sent At");

  return headers;
}

function getHeaders_(sheet) {
  const lastCol = sheet.getLastColumn();
  if (lastCol === 0) return [];
  return sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
}

function getHeaderMap_(sheet) {
  const headers = getHeaders_(sheet);
  const map = {};
  headers.forEach((header, idx) => {
    map[header] = idx;
  });
  return map;
}

function getScriptProperty_(name) {
  return PropertiesService.getScriptProperties().getProperty(name) || "";
}

function getAdminEmail_() {
  return getScriptProperty_("ADMIN_EMAIL");
}

function parseIncomingData_(e) {
  let data = {};

  if (e && e.parameter) {
    data = Object.assign({}, e.parameter);
  }

  if (e && e.postData && e.postData.contents) {
    try {
      const parsed = JSON.parse(e.postData.contents);
      data = Object.assign({}, data, parsed);
    } catch (_) {
      // ignore non-JSON body
    }
  }

  return data;
}

function buildRowFromHeaders_(sheet, headerMap, data, regId, vehicleIds, vehicleCount, paymentInfo, squareCheckout) {
  const headers = getHeaders_(sheet);
  const row = new Array(headers.length).fill("");
  const timestamp = new Date();

  const signature = pick_(data, ["signature", "Signature"]);
  const waiverAgreed = signature ? "Yes" : normalizeWaiver_(pick_(data, ["waiverAgreed", "Waiver Agreed"]));

  setByHeader_(row, headerMap, "Timestamp", timestamp);
  setByHeader_(row, headerMap, "Reg ID", regId);
  setByHeader_(row, headerMap, "First Name", pick_(data, ["firstName", "firstname", "First Name"]));
  setByHeader_(row, headerMap, "Last Name", pick_(data, ["lastName", "lastname", "Last Name"]));
  setByHeader_(row, headerMap, "Address", pick_(data, ["address", "Address"]));
  setByHeader_(row, headerMap, "City", pick_(data, ["city", "City"]));
  setByHeader_(row, headerMap, "State", pick_(data, ["state", "State"]));
  setByHeader_(row, headerMap, "Zip", pick_(data, ["zip", "zipcode", "Zip"]));
  setByHeader_(row, headerMap, "Email", pick_(data, ["email", "Email"]));
  setByHeader_(row, headerMap, "Phone", pick_(data, ["phone", "Phone"]));
  setByHeader_(row, headerMap, "Car Club", pick_(data, ["carClub", "club", "Car Club"]));

  for (let i = 1; i <= CONFIG.MAX_VEHICLES; i++) {
    setByHeader_(row, headerMap, `Vehicle ${i} Year`, getVehicleField_(data, i, "year"));
    setByHeader_(row, headerMap, `Vehicle ${i} Make`, getVehicleField_(data, i, "make"));
    setByHeader_(row, headerMap, `Vehicle ${i} Model`, getVehicleField_(data, i, "model"));
    setByHeader_(row, headerMap, `Vehicle ${i} Color`, getVehicleField_(data, i, "color"));
  }

  setByHeader_(row, headerMap, "Registration Type", paymentInfo.type);
  setByHeader_(row, headerMap, "Amount", paymentInfo.amountDisplay);
  setByHeader_(row, headerMap, "Waiver Agreed", waiverAgreed);
  setByHeader_(row, headerMap, "Signature", signature);
  setByHeader_(row, headerMap, "Date Signed", firstNonEmpty_([
    pick_(data, ["dateSigned", "Date Signed"]),
    formatDateOnly_(timestamp)
  ]));
  setByHeader_(row, headerMap, "Form Status", CONFIG.FORM_STATUS_DEFAULT);
  setByHeader_(row, headerMap, "Payment Status", CONFIG.PAYMENT_STATUS_DEFAULT);
  setByHeader_(row, headerMap, "Payment Type", "");
  setByHeader_(row, headerMap, "Square Order ID", squareCheckout.orderId);
  setByHeader_(row, headerMap, "Square Payment Link URL", squareCheckout.url);
  setByHeader_(row, headerMap, "Square Payment Link ID", squareCheckout.paymentLinkId);
  setByHeader_(row, headerMap, "Paid At", "");
  setByHeader_(row, headerMap, "Square Payment ID", "");
  setByHeader_(row, headerMap, "Notes", pick_(data, ["notes", "Notes"]));

  for (let i = 1; i <= CONFIG.MAX_VEHICLES; i++) {
    setByHeader_(row, headerMap, `Vehicle ${i} ID`, vehicleIds[i - 1] || "");
  }

  setByHeader_(row, headerMap, "Vehicle Count", vehicleCount);
  setByHeader_(row, headerMap, "Registration Total", paymentInfo.amountDisplay);
  setByHeader_(row, headerMap, "Payment Link", squareCheckout.url);
  setByHeader_(row, headerMap, "Paid Timestamp", "");
  setByHeader_(row, headerMap, "Confirmation Email Sent", "");
  setByHeader_(row, headerMap, "Confirmation Email Sent At", "");
  setByHeader_(row, headerMap, "Payment Email Sent", "");
  setByHeader_(row, headerMap, "Payment Email Sent At", "");

  return row;
}

function setByHeader_(row, headerMap, headerName, value) {
  if (headerMap.hasOwnProperty(headerName)) {
    row[headerMap[headerName]] = value;
  }
}

function pick_(obj, keys) {
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (obj[key] !== undefined && obj[key] !== null && String(obj[key]).trim() !== "") {
      return String(obj[key]).trim();
    }
  }
  return "";
}

function firstNonEmpty_(values) {
  for (let i = 0; i < values.length; i++) {
    if (values[i] !== undefined && values[i] !== null && String(values[i]).trim() !== "") {
      return values[i];
    }
  }
  return "";
}

function getVehicleField_(data, vehicleNumber, fieldName) {
  const capField = fieldName.charAt(0).toUpperCase() + fieldName.slice(1);

  const possibleKeys = [
    `vehicle${vehicleNumber}${capField}`,
    `vehicle${vehicleNumber}${fieldName}`,
    `vehicle_${vehicleNumber}_${fieldName}`,
    `Vehicle ${vehicleNumber} ${capField}`,
    `Vehicle ${vehicleNumber} ${fieldName}`
  ];

  return pick_(data, possibleKeys);
}

function countVehiclesFromFields_(data) {
  let count = 0;

  for (let i = 1; i <= CONFIG.MAX_VEHICLES; i++) {
    const vals = [
      getVehicleField_(data, i, "year"),
      getVehicleField_(data, i, "make"),
      getVehicleField_(data, i, "model"),
      getVehicleField_(data, i, "color")
    ];

    if (vals.some(v => String(v).trim() !== "")) count++;
  }

  return count;
}

function determineVehicleCount_(data) {
  const fieldCount = countVehiclesFromFields_(data);
  const explicitVehicleCount = parseInt(pick_(data, ["vehicleCount", "Vehicle Count"]), 10);

  if (!isNaN(explicitVehicleCount) && explicitVehicleCount > fieldCount) {
    return explicitVehicleCount;
  }

  const registrationType = pick_(data, ["registrationType", "Registration Type"]).toLowerCase();
  if (registrationType.includes("2") || registrationType.includes("two")) return Math.max(fieldCount, 2);
  if (registrationType.includes("1") || registrationType.includes("one")) return Math.max(fieldCount, 1);

  return Math.max(fieldCount, 1);
}

function createRegistrationId_() {
  const now = new Date();
  const tz = Session.getScriptTimeZone() || "America/Denver";

  const mm = Utilities.formatDate(now, tz, "MM");
  const dd = Utilities.formatDate(now, tz, "dd");
  const hh = Utilities.formatDate(now, tz, "HH");
  const min = Utilities.formatDate(now, tz, "mm");
  const sec = Utilities.formatDate(now, tz, "ss");

  return `SS-${mm}${dd}-${hh}${min}${sec}`;
}

function buildVehicleIds_(regId, vehicleCount) {
  const ids = [];
  for (let i = 1; i <= vehicleCount; i++) {
    ids.push(`${regId}-V${i}`);
  }
  return ids;
}

function buildPaymentInfo_(vehicleCount) {
  if (vehicleCount <= 1) {
    return {
      type: "1 Vehicle",
      amountCents: 3000,
      amountDisplay: "$30.00",
      itemName: "Steel & Style Registration - 1 Vehicle"
    };
  }

  return {
    type: "2+ Vehicles",
    amountCents: 3500,
    amountDisplay: "$35.00",
    itemName: "Steel & Style Registration - 2+ Vehicles"
  };
}

function createSquarePaymentLink_(regId, data, paymentInfo) {
  const accessToken = getScriptProperty_("SQUARE_ACCESS_TOKEN");
  const locationId = getScriptProperty_("SQUARE_LOCATION_ID");

  if (!accessToken) throw new Error("Missing Script Property: SQUARE_ACCESS_TOKEN");
  if (!locationId) throw new Error("Missing Script Property: SQUARE_LOCATION_ID");

  const buyerName = [pick_(data, ["firstName"]), pick_(data, ["lastName"])].filter(Boolean).join(" ").trim();
  const description = `Steel & Style ${regId}${buyerName ? " - " + buyerName : ""}`;

  const body = {
    idempotency_key: Utilities.getUuid(),
    description: description,
    payment_note: `Reg ID ${regId}`,
    quick_pay: {
      name: paymentInfo.itemName,
      price_money: {
        amount: paymentInfo.amountCents,
        currency: CONFIG.CURRENCY
      },
      location_id: locationId
    }
  };

  const response = UrlFetchApp.fetch(`${CONFIG.SQUARE_API_BASE}/v2/online-checkout/payment-links`, {
    method: "post",
    contentType: "application/json",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Square-Version": CONFIG.SQUARE_API_VERSION
    },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });

  const code = response.getResponseCode();
  const text = response.getContentText();
  let parsed = {};

  try {
    parsed = JSON.parse(text);
  } catch (_) {
    throw new Error(`Square response was not JSON. HTTP ${code}: ${text}`);
  }

  if (code < 200 || code >= 300) {
    throw new Error(`Square payment link create failed. HTTP ${code}: ${text}`);
  }

  const paymentLink = parsed.payment_link || {};
  return {
    paymentLinkId: paymentLink.id || "",
    orderId: paymentLink.order_id || "",
    url: paymentLink.url || ""
  };
}

function normalizeWaiver_(value) {
  if (!value) return "";
  const v = String(value).trim().toLowerCase();
  if (["true", "yes", "y", "on", "checked", "agreed"].includes(v)) return "Yes";
  if (["false", "no", "n", "off"].includes(v)) return "No";
  return value;
}

function formatDateOnly_(dateObj) {
  const tz = Session.getScriptTimeZone() || "America/Denver";
  return Utilities.formatDate(dateObj, tz, "yyyy-MM-dd");
}

function ensurePaymentStatusValidation_(sheet) {
  const headerMap = getHeaderMap_(sheet);
  if (!headerMap.hasOwnProperty("Payment Status")) return;

  const col = headerMap["Payment Status"] + 1;
  const maxRows = Math.max(sheet.getMaxRows() - 1, 1);

  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(CONFIG.PAYMENT_STATUS_OPTIONS, true)
    .setAllowInvalid(false)
    .build();

  sheet.getRange(2, col, maxRows, 1).setDataValidation(rule);
}

function maybeSendRegistrationConfirmationEmail_(sheet, rowNumber) {
  const headers = getHeaders_(sheet);
  const headerMap = getHeaderMap_(sheet);
  const row = sheet.getRange(rowNumber, 1, 1, sheet.getLastColumn()).getValues()[0];
  const registration = buildRegistrationFromStoredRow_(headers, row);

  const email = String(registration.email || "").trim();
  if (!email) return;

  const alreadySent = getCellValueByHeader_(row, headerMap, "Confirmation Email Sent");
  if (String(alreadySent).toLowerCase() === "yes") return;

  sendRegistrationConfirmationEmail_(registration);
  sendAdminRegistrationNotification_(registration);

  setCellByHeader_(sheet, rowNumber, headerMap, "Confirmation Email Sent", "Yes");
  setCellByHeader_(sheet, rowNumber, headerMap, "Confirmation Email Sent At", new Date());
}

function maybeSendPaymentConfirmationEmail_(sheet, rowNumber) {
  const headers = getHeaders_(sheet);
  const headerMap = getHeaderMap_(sheet);
  const row = sheet.getRange(rowNumber, 1, 1, sheet.getLastColumn()).getValues()[0];
  const registration = buildRegistrationFromStoredRow_(headers, row);

  const email = String(registration.email || "").trim();
  if (!email) return;

  const paymentStatus = getCellValueByHeader_(row, headerMap, "Payment Status");
  if (String(paymentStatus).trim() !== "Paid") return;

  const alreadySent = getCellValueByHeader_(row, headerMap, "Payment Email Sent");
  if (String(alreadySent).toLowerCase() === "yes") return;

  sendPaymentConfirmationEmail_(registration);

  setCellByHeader_(sheet, rowNumber, headerMap, "Payment Email Sent", "Yes");
  setCellByHeader_(sheet, rowNumber, headerMap, "Payment Email Sent At", new Date());
}

function buildRegistrationFromStoredRow_(headers, row) {
  const data = {};
  headers.forEach((header, i) => {
    data[header] = row[i];
  });

  const vehicles = [];
  for (let i = 1; i <= CONFIG.MAX_VEHICLES; i++) {
    const year = String(data[`Vehicle ${i} Year`] || "").trim();
    const make = String(data[`Vehicle ${i} Make`] || "").trim();
    const model = String(data[`Vehicle ${i} Model`] || "").trim();
    const color = String(data[`Vehicle ${i} Color`] || "").trim();

    if (year || make || model || color) {
      vehicles.push({
        year: year,
        make: make,
        model: model,
        color: color
      });
    }
  }

  return {
    regId: String(data["Reg ID"] || "").trim(),
    firstName: String(data["First Name"] || "").trim(),
    lastName: String(data["Last Name"] || "").trim(),
    email: String(data["Email"] || "").trim(),
    phone: String(data["Phone"] || "").trim(),
    carClub: String(data["Car Club"] || "").trim(),
    registrationType: String(data["Registration Type"] || "").trim(),
    amount: String(data["Registration Total"] || data["Amount"] || "").trim(),
    paymentType: String(data["Payment Type"] || "").trim(),
    paymentStatus: String(data["Payment Status"] || "").trim(),
    paymentLink: String(data["Payment Link"] || data["Square Payment Link URL"] || "").trim(),
    vehicles: vehicles
  };
}

function getCellValueByHeader_(row, headerMap, headerName) {
  if (!headerMap.hasOwnProperty(headerName)) return "";
  return row[headerMap[headerName]];
}

function setCellByHeader_(sheet, rowNumber, headerMap, headerName, value) {
  if (!headerMap.hasOwnProperty(headerName)) return;
  sheet.getRange(rowNumber, headerMap[headerName] + 1).setValue(value);
}

function sendRegistrationConfirmationEmail_(registration) {
  const vehicleText = buildVehicleText_(registration.vehicles);

  const subject = `Steel & Style Registration Received - ${registration.regId}`;

  const body =
`Thank you for registering for ${CONFIG.EVENT_NAME}.

Your registration has been received.

Registration ID: ${registration.regId}
Name: ${registration.firstName} ${registration.lastName}
Email: ${registration.email}
Phone: ${registration.phone}
Car Club: ${registration.carClub}
Registration Type: ${registration.registrationType}
Registration Total: ${registration.amount}

Vehicles:
${vehicleText}

Your payment link:
${registration.paymentLink}

Event Details:
${CONFIG.EVENT_NAME}
${CONFIG.EVENT_LOCATION}
${CONFIG.EVENT_ADDRESS}

Thank you,
Steel & Style`;

  MailApp.sendEmail({
    to: registration.email,
    subject: subject,
    body: body
  });
}

function sendPaymentConfirmationEmail_(registration) {
  const vehicleText = buildVehicleText_(registration.vehicles);

  const subject = `Steel & Style Payment Confirmed - ${registration.regId}`;

  const body =
`Your payment for ${CONFIG.EVENT_NAME} has been confirmed.

Registration ID: ${registration.regId}
Name: ${registration.firstName} ${registration.lastName}
Registration Type: ${registration.registrationType}
Registration Total: ${registration.amount}
Payment Type: ${registration.paymentType || "Paid"}
Payment Status: Paid

Vehicles:
${vehicleText}

Event Details:
${CONFIG.EVENT_NAME}
${CONFIG.EVENT_LOCATION}
${CONFIG.EVENT_ADDRESS}

Thank you for registering. We look forward to seeing you at the show.

Steel & Style`;

  MailApp.sendEmail({
    to: registration.email,
    subject: subject,
    body: body
  });
}

function sendAdminRegistrationNotification_(registration) {
  const adminEmail = getAdminEmail_();
  if (!adminEmail || String(adminEmail).indexOf("@") === -1) return;

  const vehicleText = buildVehicleText_(registration.vehicles);

  const subject = `${CONFIG.ADMIN_EMAIL_SUBJECT_TAG} NEW REGISTRATION - ${registration.regId}`;

  const body =
`A new Steel & Style registration was received.

Registration ID: ${registration.regId}
Name: ${registration.firstName} ${registration.lastName}
Email: ${registration.email}
Phone: ${registration.phone}
Car Club: ${registration.carClub}
Registration Type: ${registration.registrationType}
Registration Total: ${registration.amount}

Vehicles:
${vehicleText}

Payment Link:
${registration.paymentLink}

Event Details:
${CONFIG.EVENT_NAME}
${CONFIG.EVENT_LOCATION}
${CONFIG.EVENT_ADDRESS}`;

  MailApp.sendEmail({
    to: adminEmail,
    subject: subject,
    body: body
  });
}

function buildVehicleText_(vehicles) {
  if (!vehicles || vehicles.length === 0) {
    return "No vehicle information provided";
  }

  return vehicles.map(function(v, i) {
    const parts = [v.year, v.make, v.model].filter(Boolean);
    const line = parts.join(" ");
    return `${i + 1}. ${line}${v.color ? " (" + v.color + ")" : ""}`;
  }).join("\n");
}

function jsonResponse_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function testCreateSquareLink() {
  const data = {
    firstName: "Test",
    lastName: "User"
  };

  const regId = "SS-TEST-0001";
  const paymentInfo = {
    type: "2+ Vehicles",
    amountCents: 3500,
    amountDisplay: "$35.00",
    itemName: "Steel & Style Registration - 2+ Vehicles"
  };

  const result = createSquarePaymentLink_(regId, data, paymentInfo);
  Logger.log(JSON.stringify(result));
}

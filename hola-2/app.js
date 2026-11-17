import { supabase } from "./supabaseclient.js";

const APPOINTMENT_STATUSES = ["Pendiente", "Confirmada", "Cancelada"];
const PROJECT_STATUSES = ["Nuevo", "En revisión", "Propuesta enviada"];
const ADMIN_EMAIL = "morakeyran89@gmail.com";
const LEGAL_COPY = {
  privacy: {
    title: "Política de privacidad",
    paragraphs: [
      "Nexo Consultoría utiliza el nombre y teléfono que compartes para gestionar y dar seguimiento a tu solicitud de cita. Los datos se almacenan en Supabase y no se usan para finalidades distintas sin tu autorización.",
      "Puedes solicitar acceso, rectificación o eliminación de tus datos contactando al equipo responsable de Nexo Consultoría. Antes de publicar este sitio, completa esta política con la identidad y los datos de contacto legales de tu organización.",
    ],
  },
  terms: {
    title: "Términos y condiciones",
    paragraphs: [
      "La solicitud de una cita no confirma por sí misma la disponibilidad. El equipo de Nexo Consultoría se pondrá en contacto para confirmar o proponer otro horario.",
      "El contenido del sitio es informativo y no constituye una oferta vinculante de servicios. El alcance y las condiciones de cada servicio se acordarán directamente con el cliente.",
    ],
  },
  cookies: {
    title: "Política de cookies",
    paragraphs: [
      "Este sitio no configura cookies propias para publicidad ni seguimiento. Los proveedores externos cargados por la página (por ejemplo, Tailwind CDN, Google Fonts y Supabase) pueden procesar información técnica conforme a sus políticas.",
      "Si incorporas herramientas de analítica o marketing, actualiza esta política y solicita el consentimiento que corresponda antes de activarlas.",
    ],
  },
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHTML = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);

let bookingStep = 1;
let selectedService = "";
let activeBlogCategory = "Todas";
let eventsCache = [];
let projectsCache = [];
let adminEventsCache = [];
let adminSupabase = supabase;
let adminUserId = null;
let adminLoadingUserId = null;
let authSyncVersion = 0;
let toastTimeout;

const publicHeader = $("body > header");
const publicMain = $("body > main");
const publicFooter = $("body > footer");
const adminView = $("#admin-view");
const bookingForm = $("#booking-form");

function showMessage(element, message, isError = false) {
  element.textContent = message;
  element.className = `text-sm ${isError ? "text-red-600" : "text-emerald-700"}`;
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.remove("hidden");
  window.clearTimeout(toastTimeout);
  toastTimeout = window.setTimeout(() => toast.classList.add("hidden"), 3500);
}

function localDateString(date = new Date()) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function safeImageUrl(value) {
  const imageUrl = String(value || "").trim();
  if (/^data:image\/(?:jpeg|png|webp|gif);base64,[a-z0-9+/]+=*$/i.test(imageUrl)) return imageUrl;
  try {
    const parsedUrl = new URL(imageUrl);
    return parsedUrl.protocol === "https:" || parsedUrl.protocol === "http:" ? parsedUrl.href : "";
  } catch {
    return "";
  }
}

function updateImagePreview(value, preview, image) {
  const safeUrl = safeImageUrl(value);
  if (!safeUrl) {
    image.removeAttribute("src");
    preview.hidden = true;
    return;
  }
  image.src = safeUrl;
  preview.hidden = false;
}

function updateEventImagePreview(value) {
  updateImagePreview(value, $("#event-image-preview"), $("#event-image-preview-img"));
}

function imageCardMarkup(value, alt, heightClass) {
  const imageUrl = safeImageUrl(value);
  const fallback = '<div data-image-fallback class="grid h-full place-items-center bg-stone-100 text-sm font-bold tracking-[.2em] text-stone-400">NEXO</div>';
  if (!imageUrl) return `<div class="${heightClass} overflow-hidden">${fallback}</div>`;
  return `<div class="${heightClass} overflow-hidden bg-stone-100"><img data-fallback-image src="${escapeHTML(imageUrl)}" alt="${escapeHTML(alt)}" class="h-full w-full object-cover"><div data-image-fallback class="grid h-full place-items-center bg-stone-100 text-sm font-bold tracking-[.2em] text-stone-400" hidden>NEXO</div></div>`;
}

function handleImageLoadError(event) {
  if (!event.target.matches("[data-fallback-image]")) return;
  event.target.hidden = true;
  const fallback = event.target.nextElementSibling;
  if (fallback) fallback.hidden = false;
}

async function optimizeImage(file) {
  if (!file.type.startsWith("image/")) throw new Error("Selecciona un archivo de imagen válido.");
  if (file.size > 10 * 1024 * 1024) throw new Error("La imagen debe pesar menos de 10 MB.");
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = objectUrl;
    await image.decode();
    const maxDimension = 1400;
    const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("No se pudo procesar la imagen seleccionada.");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.82);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function generateTrackingCode() {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  const suffix = Array.from(bytes, (byte) => alphabet[byte & 31]).join("");
  return `CONS-${suffix}`;
}

async function insertAppointmentWithTrackingCode(appointment) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const codigoSeguimiento = generateTrackingCode();
    const { error } = await supabase
      .from("citas")
      .insert({ ...appointment, codigo_seguimiento: codigoSeguimiento });
    if (!error) return codigoSeguimiento;
    if (error.code !== "23505" || attempt === 2) throw error;
  }
  throw new Error("No se pudo generar un código de seguimiento único.");
}

function updateBookingStep() {
  $$("[data-booking-step]").forEach((fieldset) => {
    fieldset.hidden = Number(fieldset.dataset.bookingStep) !== bookingStep;
  });
  $$("[data-step-indicator]").forEach((indicator) => {
    const active = Number(indicator.dataset.stepIndicator) === bookingStep;
    indicator.setAttribute("aria-current", active ? "step" : "false");
    indicator.classList.toggle("bg-brand-600", active);
    indicator.classList.toggle("text-white", active);
    indicator.classList.toggle("bg-stone-100", !active);
    indicator.classList.toggle("text-stone-500", !active);
  });
  $("#step-label").textContent = `Paso ${bookingStep} de 3`;
  $("#booking-back").hidden = bookingStep === 1;
  $("#booking-next").hidden = bookingStep === 3;
  $("#booking-submit").hidden = bookingStep !== 3;
}

function validateBookingStep() {
  if (bookingStep === 1) {
    const error = $('[data-error="service"]');
    error.textContent = selectedService ? "" : "Selecciona un servicio para continuar.";
    return Boolean(selectedService);
  }
  if (bookingStep === 2) {
    const dateInput = $("#appointment-date");
    const timeInput = $("#appointment-time");
    const dateIsValid = dateInput.value && dateInput.value >= localDateString();
    const valid = dateIsValid && timeInput.value;
    $('[data-error="datetime"]').textContent = valid
      ? ""
      : !dateInput.value || !timeInput.value
        ? "Selecciona una fecha y una hora."
        : "La fecha debe ser hoy o posterior.";
    return Boolean(valid);
  }
  const nameInput = $("#customer-name");
  const phoneInput = $("#customer-phone");
  const phoneDigits = phoneInput.value.replace(/\D/g, "");
  const phoneIsValid = /^[+\d().\-\s]+$/.test(phoneInput.value.trim()) && phoneDigits.length >= 7 && phoneDigits.length <= 15;
  const valid = nameInput.value.trim().length >= 2 && phoneIsValid;
  $('[data-error="contact"]').textContent = valid
    ? ""
    : nameInput.value.trim().length < 2
      ? "Escribe tu nombre (al menos 2 caracteres)."
      : "Ingresa un teléfono válido con lada.";
  return Boolean(valid);
}

$$(".service-option").forEach((button) => {
  button.addEventListener("click", () => {
    selectedService = button.dataset.service;
    $$(".service-option").forEach((option) => option.setAttribute("aria-pressed", String(option === button)));
    $('[data-error="service"]').textContent = "";
  });
});

$("#appointment-date").min = localDateString();
$("#appointment-date").addEventListener("change", (event) => {
  if (event.currentTarget.value < localDateString()) event.currentTarget.value = "";
  $('[data-error="datetime"]').textContent = "";
});
$("#appointment-time").addEventListener("change", () => {
  $('[data-error="datetime"]').textContent = "";
});

$("#booking-next").addEventListener("click", () => {
  if (!validateBookingStep()) return;
  bookingStep = Math.min(bookingStep + 1, 3);
  updateBookingStep();
});
$("#booking-back").addEventListener("click", () => {
  bookingStep = Math.max(bookingStep - 1, 1);
  $("#booking-message").textContent = "";
  updateBookingStep();
});

bookingForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!validateBookingStep()) return;
  const submitButton = $("#booking-submit");
  submitButton.disabled = true;
  submitButton.textContent = "Enviando…";
  $("#booking-message").textContent = "";

  const appointment = {
    nombre_cliente: $("#customer-name").value.trim(),
    telefono: $("#customer-phone").value.trim(),
    servicio: selectedService,
    fecha_cita: $("#appointment-date").value,
    hora_cita: $("#appointment-time").value,
  };

  try {
    const trackingCode = await insertAppointmentWithTrackingCode(appointment);
    $("#confirmation-tracking-code").textContent = trackingCode;
    $("#copy-code-message").textContent = "";
    $("#appointment-confirmation-dialog").showModal();
    bookingForm.reset();
    selectedService = "";
    $$(".service-option").forEach((option) => option.setAttribute("aria-pressed", "false"));
    bookingStep = 1;
    updateBookingStep();
  } catch (error) {
    console.error("No se pudo registrar la cita:", error);
    showMessage($("#booking-message"), "No pudimos registrar tu solicitud. Intenta de nuevo en unos momentos.", true);
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "Solicitar cita";
  }
});

$("#confirmation-close").addEventListener("click", () => $("#appointment-confirmation-dialog").close());
$("#copy-tracking-code").addEventListener("click", async () => {
  const trackingCode = $("#confirmation-tracking-code").textContent;
  try {
    await navigator.clipboard.writeText(trackingCode);
    $("#copy-code-message").textContent = "Código copiado al portapapeles.";
    $("#copy-code-message").className = "mt-3 min-h-5 text-sm text-emerald-700";
  } catch (error) {
    console.error("No se pudo copiar el código de seguimiento:", error);
    $("#copy-code-message").textContent = "No fue posible copiarlo. Selecciona y copia el código manualmente.";
    $("#copy-code-message").className = "mt-3 min-h-5 text-sm text-amber-800";
  }
});

const appointmentTrackerDialog = $("#appointment-tracker-dialog");
$("#open-appointment-tracker").addEventListener("click", () => {
  $("#appointment-tracker-form").reset();
  $("#tracker-message").textContent = "";
  $("#tracker-result").replaceChildren();
  appointmentTrackerDialog.showModal();
  $("#tracker-code").focus();
});
$("#tracker-close").addEventListener("click", () => appointmentTrackerDialog.close());
$("#tracker-code").addEventListener("input", (event) => {
  event.currentTarget.value = event.currentTarget.value.toUpperCase().replace(/\s/g, "");
});
$("#appointment-tracker-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const code = $("#tracker-code").value.trim().toUpperCase();
  const result = $("#tracker-result");
  result.replaceChildren();
  $("#tracker-message").textContent = "";
  if (!/^CONS-[2-9A-HJ-NP-Z]{5}$/.test(code)) {
    showMessage($("#tracker-message"), "Revisa el formato del código. Debe tener el formato CONS-7A9X2.", true);
    return;
  }
  const submit = $('button[type="submit"]', event.currentTarget);
  submit.disabled = true;
  submit.textContent = "Consultando…";
  try {
    const { data, error } = await supabase
      .from("citas")
      .select("nombre_cliente, servicio, fecha_cita, hora_cita, estado")
      .eq("codigo_seguimiento", code)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      showMessage($("#tracker-message"), "No encontramos una cita con ese código. Verifica que lo hayas escrito correctamente.", true);
      return;
    }
    const status = data.estado || "Pendiente";
    const statusStyles = {
      Pendiente: "bg-amber-100 text-amber-900",
      Confirmada: "bg-emerald-100 text-emerald-900",
      Cancelada: "bg-rose-100 text-rose-800",
    };
    result.innerHTML = `<article class="rounded-2xl border border-stone-200 bg-stone-50 p-5">
      <div class="flex flex-wrap items-start justify-between gap-3"><div><p class="text-xs font-bold uppercase tracking-[.13em] text-stone-500">Reserva</p><h3 class="mt-1 text-lg font-bold text-neutral-900">${escapeHTML(data.nombre_cliente)}</h3></div><span class="rounded-full px-3 py-1.5 text-xs font-bold ${statusStyles[status] || "bg-stone-200 text-neutral-700"}">${escapeHTML(status)}</span></div>
      <dl class="mt-5 grid gap-4 border-t border-stone-200 pt-4 sm:grid-cols-2"><div><dt class="text-xs font-semibold uppercase tracking-wide text-stone-500">Servicio</dt><dd class="mt-1 text-sm font-semibold text-neutral-800">${escapeHTML(data.servicio)}</dd></div><div><dt class="text-xs font-semibold uppercase tracking-wide text-stone-500">Fecha</dt><dd class="mt-1 text-sm font-semibold text-neutral-800">${escapeHTML(data.fecha_cita)}</dd></div><div><dt class="text-xs font-semibold uppercase tracking-wide text-stone-500">Hora</dt><dd class="mt-1 text-sm font-semibold text-neutral-800">${escapeHTML(data.hora_cita)}</dd></div></dl>
    </article>`;
  } catch (error) {
    console.error("No se pudo consultar la cita por código:", error);
    showMessage($("#tracker-message"), "No pudimos consultar la cita. Intenta de nuevo más tarde.", true);
  } finally {
    submit.disabled = false;
    submit.textContent = "Consultar";
  }
});

$("#project-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = $('button[type="submit"]', form);
  const values = new FormData(form);
  const project = {
    empresa: String(values.get("empresa")).trim(),
    contacto_nombre: String(values.get("contacto_nombre")).trim(),
    correo: String(values.get("correo")).trim(),
    alcance_proyecto: String(values.get("alcance_proyecto")),
    tamano_empresa: String(values.get("tamano_empresa")),
    presupuesto_estimado: String(values.get("presupuesto_estimado")),
    descripcion_necesidad: String(values.get("descripcion_necesidad")).trim() || null,
  };
  if (!project.empresa || !project.contacto_nombre || !project.correo || !project.alcance_proyecto || !project.tamano_empresa || !project.presupuesto_estimado) {
    showMessage($("#project-message"), "Completa los campos obligatorios para enviar tu solicitud.", true);
    return;
  }
  submit.disabled = true;
  submit.textContent = "Enviando…";
  try {
    const { error } = await supabase.from("proyectos_solicitados").insert(project);
    if (error) throw error;
    form.reset();
    showMessage($("#project-message"), "Gracias. Recibimos tu brief y nos pondremos en contacto contigo.");
  } catch (error) {
    console.error("No se pudo enviar la solicitud de proyecto:", error);
    showMessage($("#project-message"), "No pudimos enviar tu solicitud. Intenta de nuevo en unos momentos.", true);
  } finally {
    submit.disabled = false;
    submit.innerHTML = 'Solicitar propuesta <span aria-hidden="true">→</span>';
  }
});

async function loadEvents() {
  const container = $("#events-list");
  container.innerHTML = '<p class="col-span-full rounded-2xl border border-stone-200 bg-white p-8 text-center text-stone-500">Cargando próximos eventos…</p>';
  try {
    const { data, error } = await supabase
      .from("charlas")
      .select("id, titulo, descripcion, fecha_evento, hora_evento, cupos_disponibles, url_imagen, tipo_acceso")
      .eq("activa", true)
      .gte("fecha_evento", localDateString())
      .order("fecha_evento", { ascending: true })
      .order("hora_evento", { ascending: true });
    if (error) throw error;
    const { data: registrations, error: registrationsError } = await supabase
      .from("inscripciones_charlas")
      .select("charla_id");
    if (registrationsError) throw registrationsError;
    const registrationCounts = new Map();
    registrations.forEach((registration) => {
      registrationCounts.set(
        registration.charla_id,
        (registrationCounts.get(registration.charla_id) || 0) + 1,
      );
    });
    eventsCache = data.map((item) => ({
      ...item,
      cupos_restantes: Math.max(0, Number(item.cupos_disponibles || 0) - (registrationCounts.get(item.id) || 0)),
    }));
    if (!eventsCache.length) {
      container.innerHTML = '<p class="col-span-full rounded-2xl border border-stone-200 bg-white p-8 text-center text-stone-500">No hay próximos eventos publicados. Vuelve pronto para conocer nuevas fechas.</p>';
      return;
    }
    container.innerHTML = eventsCache.map((event) => {
      const date = new Date(`${event.fecha_evento}T00:00:00`).toLocaleDateString("es-MX", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
      const available = event.cupos_restantes > 0;
      const imageUrl = safeImageUrl(event.url_imagen);
      const exclusive = event.tipo_acceso === "Exclusivo para Clientes";
      return `<article class="flex flex-col rounded-2xl border border-stone-200 bg-white p-6 shadow-sm transition hover:-translate-y-1 hover:shadow-soft">
        <div class="-mx-6 -mt-6 mb-5 overflow-hidden rounded-t-2xl bg-stone-100">
          <div class="relative h-48" data-event-image-container>
            <div class="absolute inset-0 grid place-items-center bg-gradient-to-br from-stone-100 to-stone-200 text-sm font-medium text-stone-400" data-event-image-fallback>Charla y aprendizaje</div>
            ${imageUrl ? `<img class="relative z-10 h-48 w-full object-cover" src="${escapeHTML(imageUrl)}" alt="${escapeHTML(event.titulo)}" loading="lazy" data-event-image />` : ""}
          </div>
        </div>
        <div class="flex flex-wrap items-center justify-between gap-2"><span class="rounded-full bg-rose-50 px-3 py-1 text-xs font-bold text-brand-700">Charla / Taller</span><span class="rounded-full px-2.5 py-1 text-[11px] font-bold ${exclusive ? "bg-amber-100 text-amber-900" : "bg-stone-100 text-stone-600"}">${exclusive ? "Exclusivo para Clientes" : "Público"}</span><span class="text-xs font-semibold ${available ? "text-emerald-700" : "text-stone-500"}">${available ? `${event.cupos_restantes} lugares` : "Cupo completo"}</span></div>
        <h3 class="mt-5 text-xl font-bold leading-snug text-neutral-900">${escapeHTML(event.titulo)}</h3>
        <p class="mt-3 flex-1 whitespace-pre-line text-sm leading-6 text-neutral-600">${escapeHTML(event.descripcion)}</p>
        <div class="mt-5 space-y-2 border-t border-stone-100 pt-4 text-sm text-neutral-600"><p><span class="mr-2 text-brand-600">◷</span>${escapeHTML(date)}</p><p><span class="mr-2 text-brand-600">◉</span>${escapeHTML(event.hora_evento)}</p></div>
        <button type="button" class="register-event mt-5 w-full rounded-xl px-4 py-3 text-sm font-bold ${available ? "bg-brand-600 text-white hover:bg-brand-700" : "cursor-not-allowed bg-stone-100 text-neutral-400"}" data-event-id="${escapeHTML(event.id)}" ${available ? "" : "disabled"}>${available ? "Inscribirme" : "Sin lugares disponibles"}</button>
      </article>`;
    }).join("");
    container.querySelectorAll("[data-event-image]").forEach((image) => {
      const hideFallback = () => {
        image.parentElement.querySelector("[data-event-image-fallback]").hidden = true;
      };
      if (image.complete && image.naturalWidth > 0) hideFallback();
      else image.addEventListener("load", hideFallback, { once: true });
    });
  } catch (error) {
    console.error("No se pudieron cargar los próximos eventos:", error);
    container.innerHTML = '<p class="col-span-full rounded-2xl border border-red-200 bg-white p-8 text-center text-sm text-red-700">No fue posible cargar los eventos. Verifica los permisos de lectura en Supabase.</p>';
  }
}

$("#events-list").addEventListener("click", (event) => {
  const button = event.target.closest(".register-event");
  if (!button || button.disabled) return;
  const selectedEvent = eventsCache.find((item) => String(item.id) === button.dataset.eventId);
  if (!selectedEvent) return;
  $("#event-registration-form").reset();
  $('#event-registration-form [name="charla_id"]').value = selectedEvent.id;
  $("#registration-event-title").textContent = selectedEvent.titulo;
  $("#registration-message").textContent = "";
  $("#event-registration-dialog").showModal();
});

$("#events-list").addEventListener("error", (event) => {
  const image = event.target.closest("[data-event-image]");
  if (!image) return;
  image.hidden = true;
  image.parentElement.querySelector("[data-event-image-fallback]").hidden = false;
}, true);

$("#registration-dialog-close").addEventListener("click", () => $("#event-registration-dialog").close());
$("#event-registration-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = new FormData(form);
  const eventId = String(values.get("charla_id"));
  const selectedEvent = eventsCache.find((item) => String(item.id) === eventId);
  if (!selectedEvent || selectedEvent.cupos_restantes < 1) {
    showMessage($("#registration-message"), "Este evento ya no tiene lugares disponibles.", true);
    return;
  }
  const submit = $('button[type="submit"]', form);
  submit.disabled = true;
  try {
    const { error } = await supabase.from("inscripciones_charlas").insert({
      charla_id: selectedEvent.id,
      nombre_asistente: String(values.get("nombre_asistente")).trim(),
      correo: String(values.get("correo")).trim(),
      empresa: String(values.get("empresa")).trim(),
    });
    if (error) throw error;
    showMessage($("#registration-message"), "Inscripción confirmada. ¡Te esperamos!");
    await loadEvents();
    window.setTimeout(() => $("#event-registration-dialog").close(), 1100);
  } catch (error) {
    console.error("No se pudo completar la inscripción:", error);
    showMessage($("#registration-message"), "No pudimos completar tu inscripción. Verifica tus datos e intenta de nuevo.", true);
  } finally {
    submit.disabled = false;
  }
});

async function loadBlog() {
  const container = $("#blog-list");
  container.innerHTML = '<p class="col-span-full rounded-2xl border border-stone-200 bg-white p-8 text-center text-stone-500">Cargando artículos…</p>';
  try {
    const [publicResult, exclusiveResult] = await Promise.all([
      supabase
        .from("entradas")
        .select("id, created_at, titulo, categoria, autor, contenido, publicado, tipo_acceso, url_imagen")
        .eq("publicado", true)
        .or("tipo_acceso.eq.Público,tipo_acceso.is.null"),
      supabase
        .from("entradas")
        .select("id, created_at, titulo, categoria, autor, publicado, tipo_acceso, url_imagen")
        .eq("publicado", true)
        .eq("tipo_acceso", "Exclusivo para Clientes"),
    ]);
    if (publicResult.error) throw publicResult.error;
    if (exclusiveResult.error) throw exclusiveResult.error;
    const articles = [
      ...publicResult.data,
      ...exclusiveResult.data.map((article) => ({ ...article, contenido: null })),
    ].sort((first, second) => new Date(second.created_at) - new Date(first.created_at));
    const data = activeBlogCategory === "Todas"
      ? articles
      : articles.filter((article) => article.categoria === activeBlogCategory);
    if (!data.length) {
      container.innerHTML = '<p class="col-span-full rounded-2xl border border-stone-200 bg-white p-8 text-center text-stone-500">Todavía no hay artículos en esta categoría.</p>';
      return;
    }
    container.innerHTML = data.map((article) => {
      const isExclusive = article.tipo_acceso === "Exclusivo para Clientes";
      const content = String(article.contenido || "");
      const excerpt = isExclusive
        ? "Este recurso está disponible para clientes Nexo. Contacta a tu consultor para solicitar acceso."
        : content.length > 240 ? `${content.slice(0, 240).trim()}…` : content;
      const date = article.created_at ? new Date(article.created_at).toLocaleDateString("es-MX", { year: "numeric", month: "long", day: "numeric" }) : "";
      return `<article class="flex flex-col overflow-hidden rounded-2xl border ${isExclusive ? "border-amber-200 bg-amber-50/40" : "border-stone-200 bg-white"} shadow-sm transition hover:-translate-y-1 hover:shadow-soft">
        ${imageCardMarkup(article.url_imagen, article.titulo, "h-44")}
        <div class="flex flex-1 flex-col p-6">
        <div class="flex flex-wrap items-center justify-between gap-3"><span class="rounded-full bg-rose-50 px-3 py-1 text-xs font-bold text-brand-700">${escapeHTML(article.categoria)}</span><span class="rounded-full ${isExclusive ? "bg-amber-100 text-amber-800" : "bg-stone-100 text-neutral-600"} px-2.5 py-1 text-[11px] font-bold">${isExclusive ? "◈ Exclusivo para clientes" : "Público"}</span><time class="text-xs text-neutral-400">${escapeHTML(date)}</time></div>
        <h3 class="mt-4 text-xl font-bold leading-snug text-neutral-900">${escapeHTML(article.titulo)}</h3>
        <p class="mt-3 flex-1 whitespace-pre-line text-sm leading-6 text-neutral-600">${escapeHTML(excerpt)}</p>
        <p class="mt-5 border-t border-stone-100 pt-4 text-xs font-semibold text-stone-500">Por ${escapeHTML(article.autor)}</p>
        </div>
      </article>`;
    }).join("");
  } catch (error) {
    console.error("No se pudieron cargar los artículos públicos:", error);
    container.innerHTML = '<p class="col-span-full rounded-2xl border border-red-200 bg-white p-8 text-center text-sm text-red-700">No fue posible cargar los artículos. Verifica la conexión y los permisos de lectura en Supabase.</p>';
  }
}

$("#blog-list").addEventListener("error", handleImageLoadError, true);

$("#blog-filters").addEventListener("click", (event) => {
  const button = event.target.closest("[data-category]");
  if (!button) return;
  activeBlogCategory = button.dataset.category;
  $$(".blog-filter").forEach((filter) => {
    const active = filter === button;
    filter.setAttribute("aria-pressed", String(active));
    filter.classList.toggle("bg-brand-600", active);
    filter.classList.toggle("text-white", active);
    filter.classList.toggle("bg-white", !active);
    filter.classList.toggle("text-neutral-600", !active);
  });
  void loadBlog();
});

function setPublicVisibility(isPublic) {
  publicHeader.hidden = !isPublic;
  publicMain.hidden = !isPublic;
  publicFooter.hidden = !isPublic;
  adminView.hidden = isPublic;
  window.scrollTo({ top: 0, behavior: "instant" });
}

async function enterAdmin() {
  setPublicVisibility(false);
  await Promise.all([
    loadAppointments(),
    loadProjects(),
    loadAdminEvents(),
    loadAdminArticles(),
  ]);
  try {
    await subscribeRealtime();
  } catch (error) {
    console.error("No se pudo activar la actualización en tiempo real:", error);
    showMessage($("#appointments-message"), "No se pudo activar la actualización en tiempo real. Usa «Actualizar» para consultar los cambios.", true);
  }
}

async function leaveAdmin() {
  if (realtimeChannel && adminSupabase) {
    try {
      await adminSupabase.removeChannel(realtimeChannel);
    } catch (error) {
      console.error("No se pudo cerrar el canal de administración:", error);
    }
    realtimeChannel = null;
  }
  adminSupabase = supabase;
  setPublicVisibility(true);
}

async function syncAdminSession(session) {
  const user = session?.user;
  if (user?.id && user.id === adminLoadingUserId) return;
  const version = ++authSyncVersion;
  if (!user || user.email !== ADMIN_EMAIL) {
    adminUserId = null;
    adminLoadingUserId = null;
    await leaveAdmin();
    if (user && version === authSyncVersion) {
      $("#admin-login-message").textContent = "Acceso denegado.";
      window.setTimeout(() => {
        if (version === authSyncVersion) {
          void supabase.auth.signOut().then(({ error }) => {
            if (error) console.error("No se pudo cerrar la sesión no autorizada:", error);
          }).catch((error) => console.error("No se pudo cerrar la sesión no autorizada:", error));
        }
      }, 0);
    }
    return;
  }
  if (user.id === adminUserId && !adminView.hidden) return;
  adminLoadingUserId = user.id;
  try {
    adminSupabase = supabase;
    await enterAdmin();
    if (version !== authSyncVersion) {
      await leaveAdmin();
      return;
    }
    adminUserId = user.id;
  } catch (error) {
    console.error("No se pudo cargar el panel administrativo:", error);
    if (version !== authSyncVersion) return;
    adminUserId = null;
    await leaveAdmin();
    $("#admin-login-message").textContent = "No fue posible cargar el panel. Verifica los permisos RLS de Supabase.";
  } finally {
    if (adminLoadingUserId === user.id) adminLoadingUserId = null;
  }
}

const adminDialog = $("#admin-dialog");
const adminLoginForm = $("#admin-login-form");
function resetAdminLogin() {
  adminLoginForm.reset();
  $("#admin-login-message").textContent = "";
}

$("#admin-access").addEventListener("click", () => {
  resetAdminLogin();
  adminDialog.showModal();
  $("#admin-password").focus();
});
$("#admin-dialog-close").addEventListener("click", () => adminDialog.close());
adminDialog.addEventListener("close", resetAdminLogin);
adminLoginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = $('button[type="submit"]', adminLoginForm);
  submit.disabled = true;
  try {
    const { error } = await supabase.auth.signInWithPassword({
      email: ADMIN_EMAIL,
      password: $("#admin-password").value,
    });
    if (error) throw error;
    adminDialog.close();
  } catch (error) {
    console.error("No se pudo iniciar sesión como administrador:", error);
    $("#admin-login-message").textContent = "No se pudo iniciar sesión. Verifica la clave e inténtalo de nuevo.";
  } finally {
    submit.disabled = false;
  }
});
async function signOutAdmin() {
  try {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
  } catch (error) {
    console.error("No se pudo cerrar la sesión administrativa:", error);
    showToast("No se pudo cerrar la sesión. Intenta de nuevo.");
  }
}
$("#admin-logout").addEventListener("click", () => void signOutAdmin());
$("#admin-logout-mobile").addEventListener("click", () => void signOutAdmin());
$("#return-public").addEventListener("click", (event) => {
  event.preventDefault();
  window.location.hash = "inicio";
  void signOutAdmin();
});

supabase.auth.onAuthStateChange((_event, session) => {
  void syncAdminSession(session);
});
supabase.auth.getSession().then(({ data, error }) => {
  if (error) {
    console.error("No se pudo recuperar la sesión de Supabase:", error);
    void syncAdminSession(null);
    return;
  }
  void syncAdminSession(data.session);
});

let realtimeChannel;
async function subscribeRealtime() {
  if (!adminSupabase) throw new Error("La sesión administrativa no está activa.");
  if (realtimeChannel) await adminSupabase.removeChannel(realtimeChannel);
  realtimeChannel = adminSupabase
    .channel("nexo-admin-changes")
    .on("postgres_changes", { event: "*", schema: "public", table: "citas" }, () => void loadAppointments())
    .on("postgres_changes", { event: "*", schema: "public", table: "proyectos_solicitados" }, () => void loadProjects())
    .on("postgres_changes", { event: "*", schema: "public", table: "charlas" }, () => {
      void loadAdminEvents();
      void loadEvents();
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "inscripciones_charlas" }, () => {
      void loadAdminEvents();
      void loadEvents();
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "entradas" }, () => {
      void loadAdminArticles();
      void loadBlog();
    })
    .subscribe((status) => {
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        showMessage($("#appointments-message"), "No se pudo activar la actualización en tiempo real. Usa «Actualizar» para consultar los cambios.", true);
      }
    });
}

function renderAppointments(rows) {
  const body = $("#appointments-body");
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="6" class="px-5 py-8 text-center text-stone-500">No hay citas registradas.</td></tr>';
    return;
  }
  body.innerHTML = rows.map((row) => {
    const statusOptions = APPOINTMENT_STATUSES.map((status) => `<option value="${status}" ${row.estado === status ? "selected" : ""}>${status}</option>`).join("");
    return `<tr>
      <td class="px-5 py-4"><p class="font-bold text-neutral-900">${escapeHTML(row.nombre_cliente)}</p><p class="mt-1 text-xs text-stone-500">${escapeHTML(row.telefono)}</p></td>
      <td class="px-5 py-4"><span class="inline-flex rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 font-mono text-xs font-bold tracking-wide text-amber-950">${escapeHTML(row.codigo_seguimiento || "—")}</span></td>
      <td class="px-5 py-4 text-neutral-600">${escapeHTML(row.servicio)}</td>
      <td class="px-5 py-4 text-neutral-600">${escapeHTML(row.fecha_cita)} · ${escapeHTML(row.hora_cita)}</td>
      <td class="px-5 py-4"><select class="appointment-status rounded-lg border border-stone-300 bg-white px-2 py-2 text-xs font-semibold" data-id="${escapeHTML(row.id)}" aria-label="Estado de ${escapeHTML(row.nombre_cliente)}">${statusOptions}</select></td>
      <td class="px-5 py-4"><button type="button" class="delete-appointment rounded-lg px-3 py-2 text-xs font-bold text-red-600 hover:bg-red-50" data-id="${escapeHTML(row.id)}">Eliminar</button></td>
    </tr>`;
  }).join("");
}

async function loadAppointments() {
  showMessage($("#appointments-message"), "Cargando citas…");
  try {
    const { data, error } = await adminSupabase.from("citas").select("id, created_at, nombre_cliente, telefono, servicio, fecha_cita, hora_cita, estado, codigo_seguimiento").order("created_at", { ascending: false });
    if (error) throw error;
    renderAppointments(data);
    $("#appointments-message").textContent = "";
    return true;
  } catch (error) {
    console.error("No se pudieron cargar las citas:", error);
    showMessage($("#appointments-message"), "No fue posible cargar las citas. Verifica las políticas RLS y permisos de Supabase.", true);
    $("#appointments-body").innerHTML = '<tr><td colspan="6" class="px-5 py-8 text-center text-red-700">Error de conexión o permisos.</td></tr>';
    return false;
  }
}

$("#refresh-appointments").addEventListener("click", () => void loadAppointments());
$("#appointments-body").addEventListener("change", async (event) => {
  const select = event.target.closest(".appointment-status");
  if (!select) return;
  const status = select.value;
  if (!APPOINTMENT_STATUSES.includes(status)) return;
  select.disabled = true;
  try {
    const { error } = await adminSupabase.from("citas").update({ estado: status }).eq("id", select.dataset.id);
    if (error) throw error;
    showMessage($("#appointments-message"), "Estado de la cita actualizado.");
  } catch (error) {
    console.error("No se pudo actualizar el estado de la cita:", error);
    showMessage($("#appointments-message"), "No se pudo actualizar la cita. Verifica los permisos de escritura.", true);
    await loadAppointments();
  } finally {
    select.disabled = false;
  }
});
$("#appointments-body").addEventListener("click", async (event) => {
  const button = event.target.closest(".delete-appointment");
  if (!button || !window.confirm("¿Eliminar esta cita de forma permanente?")) return;
  button.disabled = true;
  try {
    const { error } = await adminSupabase.from("citas").delete().eq("id", button.dataset.id);
    if (error) throw error;
    await loadAppointments();
    showMessage($("#appointments-message"), "Cita eliminada.");
  } catch (error) {
    console.error("No se pudo eliminar la cita:", error);
    showMessage($("#appointments-message"), "No se pudo eliminar la cita. Verifica los permisos de escritura.", true);
    button.disabled = false;
  }
});

function renderProjects(projects) {
  const body = $("#projects-body");
  if (!projects.length) {
    body.innerHTML = '<tr><td colspan="6" class="px-4 py-8 text-center text-stone-500">Aún no hay solicitudes de proyecto.</td></tr>';
    return;
  }
  body.innerHTML = projects.map((project) => {
    const currentStatus = project.estado || "Nuevo";
    const options = PROJECT_STATUSES.map((status) => `<option value="${escapeHTML(status)}" ${currentStatus === status ? "selected" : ""}>${escapeHTML(status)}</option>`).join("");
    return `<tr>
      <td class="px-4 py-4"><div class="flex items-center gap-3">${imageCardMarkup(project.url_imagen, project.empresa, "h-16 w-20 shrink-0 rounded-lg")}<div><p class="font-bold text-neutral-900">${escapeHTML(project.empresa)}</p><p class="mt-1 text-xs text-neutral-600">${escapeHTML(project.contacto_nombre)}</p><a class="mt-1 block text-xs text-brand-700 hover:underline" href="mailto:${escapeHTML(project.correo)}">${escapeHTML(project.correo)}</a></div></div></td>
      <td class="px-4 py-4 text-neutral-600">${escapeHTML(project.alcance_proyecto)}</td>
      <td class="px-4 py-4 text-neutral-600"><p>${escapeHTML(project.tamano_empresa)}</p><p class="mt-1 text-xs">${escapeHTML(project.presupuesto_estimado)}</p></td>
      <td class="max-w-[260px] px-4 py-4"><p class="line-clamp-3 whitespace-pre-line text-neutral-600">${escapeHTML(project.descripcion_necesidad || "Sin descripción adicional.")}</p></td>
      <td class="px-4 py-4"><select class="project-status rounded-lg border border-stone-300 bg-white px-2 py-2 text-xs font-semibold" data-id="${escapeHTML(project.id)}" aria-label="Estado de solicitud de ${escapeHTML(project.empresa)}">${options}</select></td>
      <td class="px-4 py-4"><div class="flex flex-wrap gap-2"><button type="button" class="edit-project-image rounded-lg px-3 py-2 text-xs font-bold text-brand-700 hover:bg-rose-50" data-id="${escapeHTML(project.id)}">Imagen</button><button type="button" class="delete-project rounded-lg px-3 py-2 text-xs font-bold text-red-600 hover:bg-red-50" data-id="${escapeHTML(project.id)}">Eliminar</button></div></td>
    </tr>`;
  }).join("");
}

async function loadProjects() {
  showMessage($("#projects-message"), "Cargando solicitudes…");
  try {
    const { data, error } = await adminSupabase.from("proyectos_solicitados").select("id, created_at, empresa, contacto_nombre, correo, alcance_proyecto, tamano_empresa, presupuesto_estimado, descripcion_necesidad, estado, url_imagen").order("created_at", { ascending: false });
    if (error) throw error;
    projectsCache = data;
    renderProjects(filteredProjects());
    $("#projects-message").textContent = "";
    return true;
  } catch (error) {
    console.error("No se pudieron cargar las solicitudes de proyecto:", error);
    showMessage($("#projects-message"), "No fue posible cargar los briefs. Verifica las políticas RLS y permisos de Supabase.", true);
    $("#projects-body").innerHTML = '<tr><td colspan="6" class="px-4 py-8 text-center text-red-700">Error de conexión o permisos.</td></tr>';
    return false;
  }
}

function filteredProjects() {
  const filter = $("#projects-filter").value;
  return filter === "Todas" ? projectsCache : projectsCache.filter((project) => (project.estado || "Nuevo") === filter);
}

$("#projects-filter").addEventListener("change", () => renderProjects(filteredProjects()));
$("#refresh-projects").addEventListener("click", () => void loadProjects());
$("#projects-body").addEventListener("change", async (event) => {
  const select = event.target.closest(".project-status");
  if (!select || !PROJECT_STATUSES.includes(select.value)) return;
  select.disabled = true;
  try {
    const { error } = await adminSupabase.from("proyectos_solicitados").update({ estado: select.value }).eq("id", select.dataset.id);
    if (error) throw error;
    const project = projectsCache.find((item) => String(item.id) === select.dataset.id);
    if (project) project.estado = select.value;
    renderProjects(filteredProjects());
    showMessage($("#projects-message"), "Estado de la solicitud actualizado.");
  } catch (error) {
    console.error("No se pudo actualizar el estado de la solicitud:", error);
    showMessage($("#projects-message"), "No se pudo actualizar el brief. Verifica los permisos de escritura.", true);
    await loadProjects();
  } finally {
    select.disabled = false;
  }
});
$("#projects-body").addEventListener("click", async (event) => {
  const imageButton = event.target.closest(".edit-project-image");
  if (imageButton) {
    const project = projectsCache.find((item) => String(item.id) === imageButton.dataset.id);
    if (!project) {
      showMessage($("#projects-message"), "No se encontró la solicitud de proyecto.", true);
      return;
    }
    const form = $("#project-image-form");
    form.elements.id.value = project.id;
    form.elements.url_imagen.value = project.url_imagen || "";
    $("#project-image-file").value = "";
    updateImagePreview(project.url_imagen || "", $("#project-image-preview"), $("#project-image-preview-img"));
    $("#project-image-title").textContent = `Imagen: ${project.empresa}`;
    $("#project-image-message").textContent = "";
    $("#project-image-dialog").showModal();
    return;
  }
  const button = event.target.closest(".delete-project");
  if (!button || !window.confirm("¿Eliminar esta solicitud de proyecto de forma permanente?")) return;
  button.disabled = true;
  try {
    const { error } = await adminSupabase.from("proyectos_solicitados").delete().eq("id", button.dataset.id);
    if (error) throw error;
    await loadProjects();
    showMessage($("#projects-message"), "Solicitud eliminada.");
  } catch (error) {
    console.error("No se pudo eliminar la solicitud:", error);
    showMessage($("#projects-message"), "No se pudo eliminar la solicitud. Verifica los permisos de escritura.", true);
    button.disabled = false;
  }
});

$("#projects-body").addEventListener("error", handleImageLoadError, true);

const projectImageForm = $("#project-image-form");
const projectImageUrlInput = $('[name="url_imagen"]', projectImageForm);
projectImageUrlInput.addEventListener("input", () => updateImagePreview(projectImageUrlInput.value, $("#project-image-preview"), $("#project-image-preview-img")));
$("#project-image-file").addEventListener("change", async (event) => {
  const file = event.currentTarget.files?.[0];
  if (!file) return;
  try {
    const dataUrl = await optimizeImage(file);
    projectImageUrlInput.value = dataUrl;
    updateImagePreview(dataUrl, $("#project-image-preview"), $("#project-image-preview-img"));
    $("#project-image-message").textContent = "";
  } catch (error) {
    console.error("No se pudo procesar la imagen del proyecto:", error);
    showMessage($("#project-image-message"), error.message || "No se pudo procesar la imagen seleccionada.", true);
    event.currentTarget.value = "";
  }
});
$("#remove-project-image").addEventListener("click", () => {
  projectImageUrlInput.value = "";
  $("#project-image-file").value = "";
  updateImagePreview("", $("#project-image-preview"), $("#project-image-preview-img"));
});
$("#project-image-dialog-close").addEventListener("click", () => $("#project-image-dialog").close());
$("#project-image-cancel").addEventListener("click", () => $("#project-image-dialog").close());
projectImageForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const id = String(projectImageForm.elements.id.value);
  const rawImageUrl = projectImageUrlInput.value.trim();
  const imageUrl = rawImageUrl ? safeImageUrl(rawImageUrl) : "";
  if (!id || (rawImageUrl && !imageUrl)) {
    showMessage($("#project-image-message"), "Ingresa una URL de imagen válida o selecciona un archivo.", true);
    return;
  }
  const submit = $('button[type="submit"]', projectImageForm);
  submit.disabled = true;
  try {
    const { error } = await adminSupabase.from("proyectos_solicitados").update({ url_imagen: imageUrl || null }).eq("id", id);
    if (error) throw error;
    const project = projectsCache.find((item) => String(item.id) === id);
    if (project) project.url_imagen = imageUrl || null;
    renderProjects(filteredProjects());
    $("#project-image-dialog").close();
    showMessage($("#projects-message"), "Imagen del proyecto actualizada.");
  } catch (error) {
    console.error("No se pudo actualizar la imagen del proyecto:", error);
    showMessage($("#project-image-message"), "No se pudo guardar la imagen. Verifica los permisos de escritura.", true);
  } finally {
    submit.disabled = false;
  }
});

$("#event-form [name=fecha_evento]").min = localDateString();
const eventForm = $("#event-form");
const eventImageUrlInput = $('[name="url_imagen"]', eventForm);
eventImageUrlInput.addEventListener("input", () => updateEventImagePreview(eventImageUrlInput.value));
$("#event-image-file").addEventListener("change", async (event) => {
  const file = event.currentTarget.files?.[0];
  if (!file) return;
  try {
    const dataUrl = await optimizeImage(file);
    eventImageUrlInput.value = dataUrl;
    updateEventImagePreview(dataUrl);
    $("#event-message").textContent = "";
  } catch (error) {
    console.error("No se pudo procesar la imagen del evento:", error);
    showMessage($("#event-message"), error.message || "No se pudo procesar la imagen seleccionada.", true);
    event.currentTarget.value = "";
  }
});
$("#remove-event-image").addEventListener("click", () => {
  eventImageUrlInput.value = "";
  $("#event-image-file").value = "";
  updateEventImagePreview("");
});

const articleForm = $("#article-form");
const articleImageUrlInput = $('[name="url_imagen"]', articleForm);
articleImageUrlInput.addEventListener("input", () => updateImagePreview(articleImageUrlInput.value, $("#article-image-preview"), $("#article-image-preview-img")));
$("#article-image-file").addEventListener("change", async (event) => {
  const file = event.currentTarget.files?.[0];
  if (!file) return;
  try {
    const dataUrl = await optimizeImage(file);
    articleImageUrlInput.value = dataUrl;
    updateImagePreview(dataUrl, $("#article-image-preview"), $("#article-image-preview-img"));
    $("#article-message").textContent = "";
  } catch (error) {
    console.error("No se pudo procesar la imagen del artículo:", error);
    showMessage($("#article-message"), error.message || "No se pudo procesar la imagen seleccionada.", true);
    event.currentTarget.value = "";
  }
});
$("#remove-article-image").addEventListener("click", () => {
  articleImageUrlInput.value = "";
  $("#article-image-file").value = "";
  updateImagePreview("", $("#article-image-preview"), $("#article-image-preview-img"));
});

function resetEventForm() {
  eventForm.reset();
  eventForm.elements.id.value = "";
  eventForm.elements.cupos_disponibles.value = "50";
  $("#event-form-title").textContent = "Publicar nuevo evento";
  $("#event-submit").textContent = "Publicar evento";
  $("#event-cancel-edit").hidden = true;
  updateEventImagePreview("");
  $("#event-message").textContent = "";
}

$("#event-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = new FormData(form);
  const id = String(values.get("id") || "");
  const rawImageUrl = String(values.get("url_imagen") || "").trim();
  const imageUrl = rawImageUrl ? safeImageUrl(rawImageUrl) : "";
  const eventData = {
    titulo: String(values.get("titulo")).trim(),
    descripcion: String(values.get("descripcion")).trim(),
    fecha_evento: String(values.get("fecha_evento")),
    hora_evento: String(values.get("hora_evento")),
    cupos_disponibles: Number(values.get("cupos_disponibles")),
    url_imagen: imageUrl || null,
    tipo_acceso: String(values.get("tipo_acceso") || "Público"),
  };
  if (!eventData.titulo || !eventData.descripcion || !eventData.fecha_evento || !eventData.hora_evento || !Number.isInteger(eventData.cupos_disponibles) || eventData.cupos_disponibles < 1 || !["Público", "Exclusivo para Clientes"].includes(eventData.tipo_acceso) || (rawImageUrl && !imageUrl)) {
    showMessage($("#event-message"), "Revisa los datos del evento antes de publicarlo.", true);
    return;
  }
  const submit = $('button[type="submit"]', form);
  submit.disabled = true;
  try {
    const result = id
      ? await adminSupabase.from("charlas").update(eventData).eq("id", id)
      : await adminSupabase.from("charlas").insert({ ...eventData, activa: true });
    const { error } = result;
    if (error) throw error;
    resetEventForm();
    showMessage($("#admin-events-message"), id ? "Evento actualizado correctamente." : "Evento publicado correctamente.");
    await Promise.all([loadAdminEvents(), loadEvents()]);
  } catch (error) {
    console.error("No se pudo guardar el evento:", error);
    showMessage($("#event-message"), "No se pudo guardar el evento. Revisa la URL de imagen y los permisos de escritura.", true);
  } finally {
    submit.disabled = false;
  }
});
$("#event-cancel-edit").addEventListener("click", resetEventForm);

async function loadAdminEvents() {
  showMessage($("#admin-events-message"), "Cargando eventos…");
  try {
    const { data, error } = await adminSupabase.from("charlas").select("id, titulo, descripcion, fecha_evento, hora_evento, cupos_disponibles, activa, url_imagen, tipo_acceso").order("fecha_evento", { ascending: false });
    if (error) throw error;
    adminEventsCache = data;
    const body = $("#admin-events-body");
    if (!data.length) {
      body.innerHTML = '<tr><td colspan="5" class="px-4 py-7 text-center text-stone-500">No hay eventos registrados.</td></tr>';
    } else {
      body.innerHTML = data.map((item) => `<tr>
        <td class="max-w-[220px] px-4 py-4"><p class="truncate font-semibold text-neutral-900">${escapeHTML(item.titulo)}</p><p class="mt-1 text-xs text-stone-500">${escapeHTML(item.hora_evento)}</p></td>
        <td class="px-4 py-4 text-neutral-600">${escapeHTML(item.fecha_evento)}</td>
        <td class="px-4 py-4 text-neutral-600">${escapeHTML(item.cupos_disponibles)}</td>
        <td class="px-4 py-4"><span class="rounded-full px-2.5 py-1 text-xs font-bold ${item.activa ? "bg-emerald-50 text-emerald-700" : "bg-stone-100 text-neutral-600"}">${item.activa ? "Publicado" : "Oculto"}</span></td>
        <td class="px-4 py-4"><div class="flex flex-wrap gap-2"><button type="button" class="edit-event rounded-lg px-2.5 py-2 text-xs font-bold text-brand-700 hover:bg-rose-50" data-id="${escapeHTML(item.id)}">Editar</button><button type="button" class="event-attendees-button rounded-lg px-2.5 py-2 text-xs font-bold text-brand-700 hover:bg-rose-50" data-id="${escapeHTML(item.id)}" data-title="${escapeHTML(item.titulo)}">Inscritos</button><button type="button" class="toggle-event rounded-lg px-2.5 py-2 text-xs font-bold text-neutral-600 hover:bg-stone-100" data-id="${escapeHTML(item.id)}" data-active="${String(item.activa)}">${item.activa ? "Ocultar" : "Publicar"}</button><button type="button" class="delete-event rounded-lg px-2.5 py-2 text-xs font-bold text-red-600 hover:bg-red-50" data-id="${escapeHTML(item.id)}">Eliminar</button></div></td>
      </tr>`).join("");
    }
    $("#admin-events-message").textContent = "";
    return true;
  } catch (error) {
    console.error("No se pudieron cargar los eventos del panel:", error);
    showMessage($("#admin-events-message"), "No fue posible cargar los eventos. Verifica los permisos de Supabase.", true);
    $("#admin-events-body").innerHTML = '<tr><td colspan="5" class="px-4 py-7 text-center text-red-700">Error de conexión o permisos.</td></tr>';
    return false;
  }
}

$("#admin-events-body").addEventListener("click", async (event) => {
  const editButton = event.target.closest(".edit-event");
  if (editButton) {
    const item = adminEventsCache.find((candidate) => String(candidate.id) === editButton.dataset.id);
    if (!item) {
      showMessage($("#admin-events-message"), "No se encontró el evento para editar.", true);
      return;
    }
    eventForm.elements.id.value = item.id;
    eventForm.elements.titulo.value = item.titulo || "";
    eventForm.elements.descripcion.value = item.descripcion || "";
    eventForm.elements.fecha_evento.value = item.fecha_evento || "";
    eventForm.elements.hora_evento.value = item.hora_evento || "";
    eventForm.elements.cupos_disponibles.value = item.cupos_disponibles || 50;
    eventForm.elements.url_imagen.value = item.url_imagen || "";
    eventForm.elements.tipo_acceso.value = item.tipo_acceso === "Exclusivo para Clientes" ? item.tipo_acceso : "Público";
    $("#event-image-file").value = "";
    updateEventImagePreview(item.url_imagen || "");
    $("#event-form-title").textContent = "Editar evento";
    $("#event-submit").textContent = "Guardar cambios";
    $("#event-cancel-edit").hidden = false;
    $("#event-message").textContent = "";
    eventForm.scrollIntoView({ behavior: "smooth", block: "start" });
    eventForm.elements.titulo.focus();
    return;
  }
  const attendeesButton = event.target.closest(".event-attendees-button");
  if (attendeesButton) {
    const container = $("#event-attendees");
    container.hidden = false;
    container.innerHTML = '<p class="text-sm text-stone-500">Cargando inscripciones…</p>';
    try {
      const { data, error } = await adminSupabase.from("inscripciones_charlas").select("id, nombre_asistente, correo, empresa, created_at").eq("charla_id", attendeesButton.dataset.id).order("created_at", { ascending: false });
      if (error) throw error;
      container.innerHTML = `<div class="mb-4 flex items-center justify-between gap-3"><h4 class="font-bold text-neutral-900">Inscripciones · ${escapeHTML(attendeesButton.dataset.title)}</h4><button type="button" id="close-attendees" class="rounded-lg px-2 py-1 text-sm font-bold text-stone-500 hover:bg-stone-100">Cerrar</button></div>${data.length ? `<div class="overflow-x-auto"><table class="w-full min-w-[520px] text-left text-sm"><thead class="text-xs uppercase tracking-wide text-stone-500"><tr><th class="py-2 pr-4">Asistente</th><th class="py-2 pr-4">Correo</th><th class="py-2">Empresa</th></tr></thead><tbody class="divide-y divide-stone-100">${data.map((person) => `<tr><td class="py-3 pr-4 font-semibold text-neutral-800">${escapeHTML(person.nombre_asistente)}</td><td class="py-3 pr-4 text-neutral-600"><a class="hover:text-brand-700" href="mailto:${escapeHTML(person.correo)}">${escapeHTML(person.correo)}</a></td><td class="py-3 text-neutral-600">${escapeHTML(person.empresa)}</td></tr>`).join("")}</tbody></table></div>` : '<p class="text-sm text-stone-500">Aún no hay personas inscritas.</p>'}`;
      $("#close-attendees").addEventListener("click", () => { container.hidden = true; });
    } catch (error) {
      console.error("No se pudieron cargar las inscripciones:", error);
      container.textContent = "No se pudieron cargar las inscripciones. Verifica los permisos de Supabase.";
    }
    return;
  }
  const toggleButton = event.target.closest(".toggle-event");
  if (toggleButton) {
    toggleButton.disabled = true;
    try {
      const { error } = await adminSupabase.from("charlas").update({ activa: toggleButton.dataset.active !== "true" }).eq("id", toggleButton.dataset.id);
      if (error) throw error;
      await Promise.all([loadAdminEvents(), loadEvents()]);
      showMessage($("#admin-events-message"), "Publicación del evento actualizada.");
    } catch (error) {
      console.error("No se pudo cambiar la publicación del evento:", error);
      showMessage($("#admin-events-message"), "No se pudo actualizar el evento. Verifica los permisos.", true);
      toggleButton.disabled = false;
    }
    return;
  }
  const deleteButton = event.target.closest(".delete-event");
  if (!deleteButton || !window.confirm("¿Eliminar el evento? Sus inscripciones relacionadas también se eliminarán.")) return;
  deleteButton.disabled = true;
  try {
    const { error } = await adminSupabase.from("charlas").delete().eq("id", deleteButton.dataset.id);
    if (error) throw error;
    $("#event-attendees").hidden = true;
    await Promise.all([loadAdminEvents(), loadEvents()]);
    showMessage($("#admin-events-message"), "Evento eliminado.");
  } catch (error) {
    console.error("No se pudo eliminar el evento:", error);
    showMessage($("#admin-events-message"), "No se pudo eliminar el evento. Verifica los permisos.", true);
    deleteButton.disabled = false;
  }
});

function resetArticleForm() {
  articleForm.reset();
  articleForm.elements.id.value = "";
  updateImagePreview("", $("#article-image-preview"), $("#article-image-preview-img"));
  $("#article-form-title").textContent = "Nuevo artículo";
  $("#article-cancel-edit").hidden = true;
  $("#article-message").textContent = "";
}

async function loadAdminArticles() {
  showMessage($("#articles-message"), "Cargando artículos…");
  try {
    const { data, error } = await adminSupabase.from("entradas").select("id, created_at, titulo, categoria, autor, contenido, publicado, tipo_acceso, url_imagen").order("created_at", { ascending: false });
    if (error) throw error;
    const body = $("#articles-body");
    if (!data.length) {
      body.innerHTML = '<tr><td colspan="5" class="px-4 py-7 text-center text-stone-500">No hay artículos registrados.</td></tr>';
    } else {
      body.innerHTML = data.map((article) => `<tr>
        <td class="max-w-[220px] px-4 py-4"><p class="truncate font-semibold text-neutral-900">${escapeHTML(article.titulo)}</p><p class="mt-1 text-xs text-stone-500">${escapeHTML(article.autor)}</p></td>
        <td class="px-4 py-4 text-neutral-600">${escapeHTML(article.categoria)}</td>
        <td class="px-4 py-4 text-xs text-neutral-600">${escapeHTML(article.tipo_acceso || "Público")}</td>
        <td class="px-4 py-4"><span class="rounded-full px-2.5 py-1 text-xs font-bold ${article.publicado ? "bg-emerald-50 text-emerald-700" : "bg-stone-100 text-neutral-600"}">${article.publicado ? "Publicado" : "Borrador"}</span></td>
        <td class="px-4 py-4"><div class="flex gap-2"><button type="button" class="edit-article rounded-lg px-2.5 py-2 text-xs font-bold text-brand-700 hover:bg-rose-50" data-id="${escapeHTML(article.id)}">Editar</button><button type="button" class="delete-article rounded-lg px-2.5 py-2 text-xs font-bold text-red-600 hover:bg-red-50" data-id="${escapeHTML(article.id)}">Eliminar</button></div></td>
      </tr>`).join("");
    }
    $("#articles-message").textContent = "";
    return true;
  } catch (error) {
    console.error("No se pudieron cargar los artículos del panel:", error);
    showMessage($("#articles-message"), "No fue posible cargar los artículos. Verifica los permisos de Supabase.", true);
    $("#articles-body").innerHTML = '<tr><td colspan="5" class="px-4 py-7 text-center text-red-700">Error de conexión o permisos.</td></tr>';
    return false;
  }
}

$("#article-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = new FormData(form);
  const id = String(values.get("id") || "");
  const article = {
    titulo: String(values.get("titulo")).trim(),
    categoria: String(values.get("categoria")),
    tipo_acceso: String(values.get("tipo_acceso") || "Público"),
    autor: String(values.get("autor")).trim(),
    contenido: String(values.get("contenido")).trim(),
    url_imagen: null,
    publicado: true,
  };
  const rawImageUrl = String(values.get("url_imagen") || "").trim();
  article.url_imagen = rawImageUrl ? safeImageUrl(rawImageUrl) : null;
  if (!article.titulo || !article.categoria || !article.autor || !article.contenido || (rawImageUrl && !article.url_imagen)) {
    showMessage($("#article-message"), "Revisa los campos obligatorios y la URL de imagen.", true);
    return;
  }
  const submit = $('button[type="submit"]', form);
  submit.disabled = true;
  try {
    const result = id
      ? await adminSupabase.from("entradas").update(article).eq("id", id)
      : await adminSupabase.from("entradas").insert(article);
    if (result.error) throw result.error;
    resetArticleForm();
    await Promise.all([loadAdminArticles(), loadBlog()]);
    showMessage($("#articles-message"), id ? "Artículo actualizado." : "Artículo publicado.");
  } catch (error) {
    console.error("No se pudo guardar el artículo:", error);
    showMessage($("#article-message"), "No se pudo guardar el artículo. Verifica los permisos de escritura.", true);
  } finally {
    submit.disabled = false;
  }
});

$("#article-cancel-edit").addEventListener("click", resetArticleForm);
$("#articles-body").addEventListener("click", async (event) => {
  const editButton = event.target.closest(".edit-article");
  if (editButton) {
    try {
      const { data, error } = await adminSupabase.from("entradas").select("id, titulo, categoria, autor, contenido, tipo_acceso, url_imagen").eq("id", editButton.dataset.id).single();
      if (error) throw error;
      const form = $("#article-form");
      $("[name=id]", form).value = data.id;
      $("[name=titulo]", form).value = data.titulo;
      $("[name=categoria]", form).value = data.categoria;
      $("[name=tipo_acceso]", form).value = data.tipo_acceso || "Público";
      $("[name=autor]", form).value = data.autor;
      $("[name=contenido]", form).value = data.contenido;
      $("[name=url_imagen]", form).value = data.url_imagen || "";
      $("#article-image-file").value = "";
      updateImagePreview(data.url_imagen || "", $("#article-image-preview"), $("#article-image-preview-img"));
      $("#article-form-title").textContent = "Editar artículo";
      $("#article-cancel-edit").hidden = false;
      $("#article-message").textContent = "";
      form.scrollIntoView({ behavior: "smooth", block: "start" });
      $("[name=titulo]", form).focus();
    } catch (error) {
      console.error("No se pudo cargar el artículo para editarlo:", error);
      showMessage($("#articles-message"), "No se pudo abrir el artículo para editar.", true);
    }
    return;
  }
  const deleteButton = event.target.closest(".delete-article");
  if (!deleteButton || !window.confirm("¿Eliminar este artículo de forma permanente?")) return;
  deleteButton.disabled = true;
  try {
    const { error } = await adminSupabase.from("entradas").delete().eq("id", deleteButton.dataset.id);
    if (error) throw error;
    resetArticleForm();
    await Promise.all([loadAdminArticles(), loadBlog()]);
    showMessage($("#articles-message"), "Artículo eliminado.");
  } catch (error) {
    console.error("No se pudo eliminar el artículo:", error);
    showMessage($("#articles-message"), "No se pudo eliminar el artículo. Verifica los permisos de escritura.", true);
    deleteButton.disabled = false;
  }
});

$$(".admin-tab").forEach((button) => {
  button.addEventListener("click", () => {
    $$(".admin-panel").forEach((panel) => { panel.hidden = panel.id !== button.dataset.panel; });
    $$(".admin-tab").forEach((tab) => {
      const active = tab === button;
      tab.classList.toggle("bg-white/10", active && tab.closest("aside") !== null);
      tab.classList.toggle("bg-brand-50", active && tab.closest(".md\\:hidden") !== null);
      tab.setAttribute("aria-current", active ? "page" : "false");
    });
  });
});

const legalDialog = $("#legal-dialog");
$("#legal-close").addEventListener("click", () => legalDialog.close());
$$(".legal-link").forEach((button) => {
  button.addEventListener("click", () => {
    const content = LEGAL_COPY[button.dataset.legal];
    $("#legal-title").textContent = content.title;
    $("#legal-content").replaceChildren(...content.paragraphs.map((paragraph) => {
      const element = document.createElement("p");
      element.textContent = paragraph;
      return element;
    }));
    legalDialog.showModal();
  });
});

$("#current-year").textContent = String(new Date().getFullYear());
updateBookingStep();
void loadBlog();
void loadEvents();
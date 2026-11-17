import { describe, expect, it } from "vitest";
import { fechaLeida, leerRespuestaFecha, normalizarNit, normalizarNumero } from "../src/invoice-key.js";

describe("normalizarNit", () => {
  it("quita puntos, guiones y el dígito de verificación", () => {
    expect(normalizarNit("900.155.107-1")).toBe("900155107");
    expect(normalizarNit("900155107")).toBe("900155107");
    expect(normalizarNit(" 900 155 107 ")).toBe("900155107");
  });

  it("sin dígitos no hay NIT", () => {
    expect(normalizarNit(null)).toBeNull();
    expect(normalizarNit("")).toBeNull();
    expect(normalizarNit("—")).toBeNull();
  });
});

describe("normalizarNumero", () => {
  it("ignora espacios y mayúsculas", () => {
    expect(normalizarNumero(" fe 202443 ")).toBe("FE202443");
    expect(normalizarNumero("")).toBeNull();
  });
});

describe("leerRespuestaFecha", () => {
  const HOY = "2026-11-17";
  it("acepta hoy, AAAA-MM-DD y DD/MM/AAAA", () => {
    expect(leerRespuestaFecha("hoy", HOY)).toBe(HOY);
    expect(leerRespuestaFecha("2026-11-10", HOY)).toBe("2026-11-10");
    expect(leerRespuestaFecha("10/11/2026", HOY)).toBe("2026-11-10");
  });

  it("rechaza fechas que no existen y textos que no son fechas", () => {
    expect(leerRespuestaFecha("2026-02-30", HOY)).toBeNull();
    expect(leerRespuestaFecha("31/11/2026", HOY)).toBeNull();
    expect(leerRespuestaFecha("cuánto gasté", HOY)).toBeNull();
    expect(leerRespuestaFecha("ayer", HOY)).toBeNull();
  });
});

describe("fechaLeida", () => {
  it("solo acepta fechas completas y válidas", () => {
    expect(fechaLeida("2026-11-10")).toBe("2026-11-10");
    expect(fechaLeida(null)).toBeNull();
    expect(fechaLeida("10/11/2026")).toBeNull();
    expect(fechaLeida("2026-13-01")).toBeNull();
  });
});

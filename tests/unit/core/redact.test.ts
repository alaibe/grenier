import { redact } from "@grenier/core";
import { describe, expect, it } from "vitest";

describe("redact", () => {
  it("removes valid IBANs, with or without spaces, and leaves look-alikes", () => {
    expect(redact("Pay to FR76 3000 6000 0112 3456 7890 189 today")).toBe("Pay to [IBAN removed] today");
    expect(redact("IBAN: DE89370400440532013000.")).toBe("IBAN: [IBAN removed].");
    expect(redact("Order FR12 3456 7890 1234 5678 900 is not one")).toBe(
      "Order FR12 3456 7890 1234 5678 900 is not one",
    );
  });

  it("removes phone numbers in common national and international forms", () => {
    expect(redact("Call me on +33 6 12 34 56 78.")).toBe("Call me on [phone removed].");
    expect(redact("Office: 01.23.45.67.89")).toBe("Office: [phone removed]");
    expect(redact("US: (415) 555-0132 or +1-415-555-0132")).toBe("US: [phone removed] or [phone removed]");
    expect(redact("UK 0044 20 7946 0958")).toBe("UK [phone removed]");
  });

  it("leaves dates, times, versions, short numbers and amounts alone", () => {
    const text = "On 2026-11-16 at 14:30, v4.13.17 cost 1,250.00 EUR for 3 seats (order 12345).";
    expect(redact(text)).toBe(text);
  });

  it("removes street addresses with their postal code and town", () => {
    expect(redact("Meet at 12 rue de la Paix, 75002 Paris tomorrow")).toBe("Meet at [address removed] tomorrow");
    expect(redact("Ship to 221B Baker Street, London")).toBe("Ship to [address removed], London");
    expect(redact("We moved to 1600 Amphitheatre Parkway")).toBe("We moved to 1600 Amphitheatre Parkway");
  });
});

import { redact } from "@grenier/core";
import { describe, expect, it } from "vitest";

describe("redact", () => {
  it("removes valid IBANs, with or without tops, and leaves look-alikes", () => {
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

  it("leaves a date and time written together, and IPv4 addresses, alone", () => {
    for (const text of [
      "Standup 2026-11-19 14:30, then 2026-11-19T14:30:05Z.",
      "On 19/11/2026 and 19.11.2026 at 09:15:30.",
      "Server 192.168.100.200, gateway 10.0.0.1.",
    ]) {
      expect(redact(text)).toBe(text);
    }
    expect(redact("Order 12345678901 shipped.")).toBe("Order [phone removed] shipped.");
    expect(redact("\uE000 icon, call +33 6 12 34 56 78")).toBe("\uE000 icon, call [phone removed]");
  });

  it("removes card numbers that pass the Luhn check, with or without separators", () => {
    expect(redact("My card is 4111 1111 1111 1111.")).toBe("My card is [card removed].");
    expect(redact("Card 5555-5555-5555-4444 expires")).toBe("Card [card removed] expires");
    expect(redact("Amex 378282246310005")).toBe("Amex [card removed]");
    expect(redact("Ref 4111 1111 1111 1112 is not one")).toBe("Ref 4111 1111 1111 1112 is not one");
    expect(redact("Amex 3782 822463 10005")).toBe("Amex [card removed]");
  });

  it("never takes a run of dates or of small numbers for a card", () => {
    for (let day = 0; day < 400; day++) {
      const from = new Date(Date.UTC(2026, 0, 1 + day)).toISOString().slice(0, 10);
      const to = new Date(Date.UTC(2026, 0, 2 + day)).toISOString().slice(0, 10);
      expect(redact(`From ${from} to ${to}.`)).toBe(`From ${from} to ${to}.`);
    }
    expect(redact("Scores: 1234 5678 1234 5678 90")).not.toContain("[card removed]");
    expect(redact("Ids 4111111111111111111111")).not.toContain("[card removed]");
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

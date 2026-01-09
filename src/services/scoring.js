export function scoreMenuLine(line) {
    const l = (line || "").toLowerCase();
    let score = 70;
    const reasons = [];
  
    // Positive signals
    if (l.includes("grilled") || l.includes("baked") || l.includes("steamed")) {
      score += 10; reasons.push("Grilled/baked");
    }
    if (l.includes("salad") || l.includes("veggie") || l.includes("greens")) {
      score += 8; reasons.push("Veggies/greens");
    }
    if (l.includes("chicken") || l.includes("fish") || l.includes("tofu") || l.includes("lentil")) {
      score += 6; reasons.push("Lean protein");
    }
  
    // Risk signals
    if (l.includes("fried") || l.includes("crispy") || l.includes("tempura")) {
      score -= 18; reasons.push("Fried");
    }
    if (l.includes("creamy") || l.includes("alfredo") || l.includes("cheese")) {
      score -= 10; reasons.push("Heavier sauce");
    }
    if (l.includes("sweet") || l.includes("dessert") || l.includes("syrup") || l.includes("honey")) {
      score -= 12; reasons.push("High sugar");
    }
    if (l.includes("bacon") || l.includes("pepperoni") || l.includes("sausage")) {
      score -= 10; reasons.push("Processed meat");
    }
  
    score = Math.max(0, Math.min(100, score));
    const verdict = score >= 80 ? "FIT" : score >= 60 ? "MODERATE" : "AVOID";
  
    return { score, verdict, reasons: reasons.slice(0, 3) };
  }
  
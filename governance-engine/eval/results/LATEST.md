# Auzaar Eval Report

Generated: 2026-04-04T05:38:49.741Z

## Threat Detection (Heuristic)

| Metric | Value |
|--------|-------|
| Precision | 1 |
| Recall | 0.467 |
| F1 | 0.636 |

### Confusion Matrix

|  | Predicted Threat | Predicted Benign |
|--|-----------------|-----------------|
| Actual Threat | 21 (TP) | 24 (FN) |
| Actual Benign | 0 (FP) | 45 (TN) |

### Per-Category

| Category | Precision | Recall | F1 | Support |
|----------|-----------|--------|----|---------|
| prompt_injection | 1 | 0.933 | 0.966 | 15 |
| goal_hijacking | 1 | 0.067 | 0.125 | 15 |
| suspicious_vendor | 1 | 0.6 | 0.75 | 10 |
| anomalous_amount | 0 | 0 | 0 | 5 |
| benign | 0 | 0 | 0 | 45 |

## Intent Alignment (Structural + TF-IDF)

| Metric | Value |
|--------|-------|
| Drift Detection Precision | 1 |
| Drift Detection Recall | 0.8 |
| Drift Detection F1 | 0.889 |

### Per-Label Accuracy

| Label | Accuracy | Support |
|-------|----------|---------|
| aligned | 1 | 15 |
| partial_drift | 0.133 | 15 |
| full_drift | 0.8 | 15 |

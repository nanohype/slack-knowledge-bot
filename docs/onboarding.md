# SlackKnowledgeBot — Employee Onboarding Playbook
**Version:** 1.0  
**Author:** tech-writer  
**Audience:** NanoCorp employees (first-time SlackKnowledgeBot users)

---

## Welcome to SlackKnowledgeBot 👋

SlackKnowledgeBot is NanoCorp's internal knowledge assistant. Ask it anything — it searches across Notion, Confluence, and Google Drive on your behalf and gives you a cited, grounded answer right in Slack.

**SlackKnowledgeBot is read-only.** It will never write to or modify any of your documents.

---

## Getting Started

### Step 1: Find SlackKnowledgeBot in Slack

Search for **@SlackKnowledgeBot** in Slack. You can:
- Send it a **direct message** (most private)
- **@mention it** in any channel where it's been added (`@slack-knowledge-bot your question`)

### Step 2: Authorize Your Accounts

The first time you ask SlackKnowledgeBot a question, it'll ask you to connect your knowledge sources. This is how it reads docs on your behalf — using your own access, so you'll only ever see what you already have permission to see.

You'll see a prompt like this:

> 🔗 SlackKnowledgeBot needs access to your knowledge sources to answer this question.
> [Connect Notion] [Connect Confluence] [Connect Google Drive]

Click each button and follow the standard OAuth flow. Your credentials are:
- Encrypted using AWS KMS (bank-grade encryption)
- Stored only in NanoCorp's own AWS account
- Never shared with any third party

You'll only need to do this once (or when your access tokens expire, roughly every year).

---

## Asking Questions

### How to ask

```
@slack-knowledge-bot What is NanoCorp's expense reimbursement policy?
```

```
@slack-knowledge-bot How do I set up the local dev environment for the API service?
```

```
@slack-knowledge-bot What did we decide about the Q3 roadmap prioritization?
```

### Tips for better answers

| Do | Don't |
|----|-------|
| Ask specific questions | Ask vague questions ("tell me everything about sales") |
| Include context ("for the backend team", "for EMEA customers") | Expect SlackKnowledgeBot to know about meetings it wasn't given notes from |
| Ask follow-up questions | Assume the first answer is exhaustive |

---

## Understanding Responses

### Anatomy of an SlackKnowledgeBot answer

```
Here's the expense policy for NanoCorp:
Employees can submit expenses up to $500 without pre-approval...
[Q3 Expense Policy](https://notion.so/page/xxx) Updated Jan 10, 2025

• 📄 Q3 Expense Policy — Updated Jan 10, 2025
• 📄 Finance FAQ — Updated Dec 1, 2024 ⚠️ Last updated Oct 15, 2024 — may be outdated

Powered by SlackKnowledgeBot — answers are grounded in NanoCorp's knowledge base.
```

### What the icons mean

| Icon | Meaning |
|------|---------|
| 📄 | Source document link |
| ⚠️ | This document is more than 90 days old — the information may be outdated |
| 🔒 | A relevant document exists but you don't have access to it |

### When SlackKnowledgeBot says "I don't have access"

If SlackKnowledgeBot says:
> _"I found a potentially relevant document but don't have permission to access it on your behalf."_

This means there's a doc in the index that you don't have access to in Notion/Confluence/Drive. To get the information:
1. Ask your team lead who owns the document
2. Request access through the normal permissions process in that tool

### When SlackKnowledgeBot has no answer

If SlackKnowledgeBot says:
> _"I didn't find relevant information in the knowledge base for your question."_

This means no well-matching documents were found (for you). Try:
- Rephrasing with different terminology
- Checking if the relevant docs are in a space/workspace you have access to
- Adding the information to a shared doc so future queries return it

---

## Privacy & Data

- SlackKnowledgeBot **only reads** documents — it never writes, edits, or deletes anything
- Your questions are logged (anonymized) for security and compliance purposes, per NanoCorp's data policy
- Your questions are **not** used to train any AI model
- SlackKnowledgeBot only accesses documents you personally have permission to read in the source system

For questions about data handling, contact the NanoCorp Privacy team.

---

## Rate Limits

To ensure fair access for everyone:
- **20 queries per hour** per person
- If you hit the limit, SlackKnowledgeBot will tell you when you can ask again

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| SlackKnowledgeBot doesn't respond | Check if it's added to your channel; try a DM |
| Getting "can't access" for your own docs | Re-authorize via the link SlackKnowledgeBot sends you |
| Answers seem outdated | Check the ⚠️ staleness warning on the cited source |
| SlackKnowledgeBot gives a wrong answer | Report it to `#slack-knowledge-bot-feedback`; cite the doc that has the correct info |
| Need to revoke SlackKnowledgeBot's access | Revoke in Notion/Confluence/Google settings; contact IT to remove your token record |

---

## Feedback & Support

- 💬 Channel: `#slack-knowledge-bot-feedback`
- 🐛 Bugs: `#slack-knowledge-bot-bugs`
- 📖 This playbook: [SlackKnowledgeBot docs in Notion](https://notion.so/slack-knowledge-bot-docs)

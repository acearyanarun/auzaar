# create_ticket

Create a new project ticket with a title, body, and optional priority.

```json
{
  "name": "create_ticket",
  "description": "Create a new project ticket with a title and body.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "title": {
        "type": "string",
        "description": "Ticket title"
      },
      "body": {
        "type": "string",
        "description": "Detailed ticket description"
      },
      "priority": {
        "type": "string",
        "enum": ["low", "medium", "high", "critical"],
        "description": "Ticket priority level"
      }
    },
    "required": ["title", "body"]
  },
  "annotations": {
    "audience": ["developer", "pm"],
    "readOnly": false
  }
}
```

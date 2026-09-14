#!/usr/bin/env python3
"""Small stdin/stdout bridge for the Mac-only Exchange EWS revisit sender."""

import json
import os
import re
import sys
from xml.sax.saxutils import escape

import requests
from requests_ntlm import HttpNtlmAuth
from dotenv import load_dotenv


SOAP = """<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
  xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages">
  <soap:Header><t:RequestServerVersion Version="Exchange2013"/></soap:Header>
  <soap:Body>{body}</soap:Body>
</soap:Envelope>"""


def result(ok, **extra):
    print(json.dumps({"ok": ok, **extra}, ensure_ascii=False))


def mailbox(address, name=""):
    label = f"<t:Name>{escape(name)}</t:Name>" if name else ""
    return f"<t:Mailbox>{label}<t:EmailAddress>{escape(address)}</t:EmailAddress></t:Mailbox>"


def response_error(response):
    code = re.search(r"<(?:\w+:)?ResponseCode>([^<]+)", response.text or "")
    message = re.search(r"<(?:\w+:)?MessageText>([^<]+)", response.text or "")
    return " · ".join(part for part in [
        f"HTTP {response.status_code}" if response.status_code != 200 else "",
        code.group(1) if code and code.group(1) != "NoError" else "",
        message.group(1) if message else ""
    ] if part) or "ews_invalid_response"


def main():
    action = sys.argv[1] if len(sys.argv) > 1 else ""
    env_file = os.environ.get("REVISIT_EMAIL_EWS_ENV_FILE", "").strip()
    if env_file:
        load_dotenv(env_file, override=False)
    endpoint = os.environ.get("REVISIT_EMAIL_EWS_URL", "").strip()
    user = (os.environ.get("REVISIT_EMAIL_EWS_USER", "") or os.environ.get("OUTREACH_EWS_USER", "")).strip()
    password = os.environ.get("REVISIT_EMAIL_EWS_PASSWORD", "") or os.environ.get("OUTREACH_EWS_PASSWORD", "")
    if not endpoint.startswith("https://") or not user or not password:
        result(False, error="ews_not_configured")
        return
    try:
        payload = json.load(sys.stdin)
        session = requests.Session()
        session.auth = HttpNtlmAuth(user, password)

        def post(body):
            return session.post(
                endpoint,
                data=SOAP.format(body=body).encode("utf-8"),
                headers={"Content-Type": "text/xml; charset=utf-8"},
                timeout=90,
            )

        if action == "verify":
            response = post('<m:GetFolder><m:FolderShape><t:BaseShape>IdOnly</t:BaseShape>'
                            '</m:FolderShape><m:FolderIds><t:DistinguishedFolderId Id="drafts"/>'
                            '</m:FolderIds></m:GetFolder>')
        elif action == "send":
            to = str(payload.get("to", "")).strip()
            subject = str(payload.get("subject", "")).strip()
            html = str(payload.get("html", ""))
            if not to or not subject or not html:
                result(False, error="missing_required_fields")
                return
            from_email = (str(payload.get("senderEmail", "")).strip()
                          or os.environ.get("REVISIT_EMAIL_EWS_FROM_EMAIL", "").strip()
                          or os.environ.get("OUTREACH_SEND_AS", "").strip())
            reply_to = (str(payload.get("replyTo", "")).strip()
                        or os.environ.get("REVISIT_EMAIL_EWS_REPLY_TO", "").strip()
                        or os.environ.get("OUTREACH_REPLY_TO", "").strip())
            from_xml = f"<t:From>{mailbox(from_email, str(payload.get('senderName', '')).strip())}</t:From>" if from_email else ""
            reply_xml = f"<t:ReplyTo>{mailbox(reply_to)}</t:ReplyTo>" if reply_to else ""
            response = post(
                '<m:CreateItem MessageDisposition="SendAndSaveCopy">'
                '<m:SavedItemFolderId><t:DistinguishedFolderId Id="sentitems"/></m:SavedItemFolderId>'
                '<m:Items><t:Message>'
                f'<t:Subject>{escape(subject)}</t:Subject>'
                f'<t:Body BodyType="HTML">{escape(html)}</t:Body>'
                f'<t:ToRecipients>{mailbox(to, str(payload.get("toName", "")).strip())}</t:ToRecipients>'
                f'{from_xml}{reply_xml}'
                '</t:Message></m:Items></m:CreateItem>'
            )
        else:
            result(False, error="ews_unknown_action")
            return
        if response.status_code == 200 and "NoError" in response.text:
            result(True, messageId="", response="NoError")
        else:
            result(False, error=response_error(response))
    except requests.RequestException as exc:
        status = exc.response.status_code if exc.response is not None else None
        result(False, error=f"HTTP {status}" if status else exc.__class__.__name__)
    except Exception as exc:
        result(False, error=exc.__class__.__name__)


if __name__ == "__main__":
    main()

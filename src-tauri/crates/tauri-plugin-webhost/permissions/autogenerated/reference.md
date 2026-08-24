## Default Permission

The commands a Paper webview needs from the webhost plugin: the server's
status and bound port; showing and cancelling the six-digit code a human types
into a browser; listing and revoking paired browsers; and the frame pipe
(ready, send, recv) between a browser's socket and the service router.

The server binds loopback only and answers no service call itself — it carries
frames to the webview, which holds the router.

#### This default permission set includes the following:

- `allow-webhost-status`
- `allow-webhost-begin-code`
- `allow-webhost-cancel-code`
- `allow-webhost-sessions`
- `allow-webhost-revoke`
- `allow-webhost-ready`
- `allow-webhost-send`
- `allow-webhost-session-recv`

## Permission Table

<table>
<tr>
<th>Identifier</th>
<th>Description</th>
</tr>


<tr>
<td>

`webhost:allow-webhost-begin-code`

</td>
<td>

Enables the webhost_begin_code command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`webhost:deny-webhost-begin-code`

</td>
<td>

Denies the webhost_begin_code command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`webhost:allow-webhost-cancel-code`

</td>
<td>

Enables the webhost_cancel_code command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`webhost:deny-webhost-cancel-code`

</td>
<td>

Denies the webhost_cancel_code command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`webhost:allow-webhost-ready`

</td>
<td>

Enables the webhost_ready command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`webhost:deny-webhost-ready`

</td>
<td>

Denies the webhost_ready command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`webhost:allow-webhost-revoke`

</td>
<td>

Enables the webhost_revoke command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`webhost:deny-webhost-revoke`

</td>
<td>

Denies the webhost_revoke command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`webhost:allow-webhost-send`

</td>
<td>

Enables the webhost_send command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`webhost:deny-webhost-send`

</td>
<td>

Denies the webhost_send command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`webhost:allow-webhost-session-recv`

</td>
<td>

Enables the webhost_session_recv command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`webhost:deny-webhost-session-recv`

</td>
<td>

Denies the webhost_session_recv command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`webhost:allow-webhost-sessions`

</td>
<td>

Enables the webhost_sessions command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`webhost:deny-webhost-sessions`

</td>
<td>

Denies the webhost_sessions command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`webhost:allow-webhost-status`

</td>
<td>

Enables the webhost_status command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`webhost:deny-webhost-status`

</td>
<td>

Denies the webhost_status command without any pre-configured scope.

</td>
</tr>
</table>

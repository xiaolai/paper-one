## Default Permission

The commands a Paper webview needs from the webhost plugin: the server's
status and bound port; showing and cancelling the six-digit code a human types
into a browser; listing and revoking paired browsers, one or all; and the frame
pipe (ready, send, recv) between a browser's socket and the service router.

The server binds loopback only and answers no service call itself — it carries
frames to the webview, which holds the router.

#### This default permission set includes the following:

- `allow-webhost-status`
- `allow-webhost-address`
- `allow-webhost-begin-code`
- `allow-webhost-cancel-code`
- `allow-webhost-sessions`
- `allow-webhost-browsers`
- `allow-webhost-revoke`
- `allow-webhost-revoke-all`
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

`webhost:allow-webhost-address`

</td>
<td>

Enables the webhost_address command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`webhost:deny-webhost-address`

</td>
<td>

Denies the webhost_address command without any pre-configured scope.

</td>
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

`webhost:allow-webhost-browsers`

</td>
<td>

Enables the webhost_browsers command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`webhost:deny-webhost-browsers`

</td>
<td>

Denies the webhost_browsers command without any pre-configured scope.

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

`webhost:allow-webhost-revoke-all`

</td>
<td>

Enables the webhost_revoke_all command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`webhost:deny-webhost-revoke-all`

</td>
<td>

Denies the webhost_revoke_all command without any pre-configured scope.

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

## Default Permission

The commands a Paper webview needs from the voices plugin: the catalogue of
downloadable voice packs and which are installed; fetching one, stopping a
fetch, and removing one; reading text aloud through an installed pack; and
letting a loaded model go.

⚠️ FETCHING A PACK IS A NETWORK REQUEST AND A LARGE ONE — up to 2.5 GB from the
hosts the embedded manifest pins by revision. It is never started by anything
but a reader pressing Download, every byte is checked against the manifest's
digest before it is promoted, and a stopped fetch leaves nothing half-installed.
Nothing here can reach a URL the manifest does not name.

Rendering holds a model — about 2.5 GB resident for the Chinese pack — until
`voices_release`, which is why releasing is a command rather than a timer the
webview cannot reach.

#### This default permission set includes the following:

- `allow-voices-catalogue`
- `allow-voices-install`
- `allow-voices-stop`
- `allow-voices-remove`
- `allow-voices-render`
- `allow-voices-render-file`
- `allow-voices-release`

## Permission Table

<table>
<tr>
<th>Identifier</th>
<th>Description</th>
</tr>


<tr>
<td>

`voices:allow-voices-catalogue`

</td>
<td>

Enables the voices_catalogue command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`voices:deny-voices-catalogue`

</td>
<td>

Denies the voices_catalogue command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`voices:allow-voices-install`

</td>
<td>

Enables the voices_install command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`voices:deny-voices-install`

</td>
<td>

Denies the voices_install command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`voices:allow-voices-release`

</td>
<td>

Enables the voices_release command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`voices:deny-voices-release`

</td>
<td>

Denies the voices_release command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`voices:allow-voices-remove`

</td>
<td>

Enables the voices_remove command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`voices:deny-voices-remove`

</td>
<td>

Denies the voices_remove command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`voices:allow-voices-render`

</td>
<td>

Enables the voices_render command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`voices:deny-voices-render`

</td>
<td>

Denies the voices_render command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`voices:allow-voices-render-file`

</td>
<td>

Enables the voices_render_file command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`voices:deny-voices-render-file`

</td>
<td>

Denies the voices_render_file command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`voices:allow-voices-stop`

</td>
<td>

Enables the voices_stop command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`voices:deny-voices-stop`

</td>
<td>

Denies the voices_stop command without any pre-configured scope.

</td>
</tr>
</table>

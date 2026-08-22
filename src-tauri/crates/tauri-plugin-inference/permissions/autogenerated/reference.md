## Default Permission

The commands a Paper webview needs from the inference plugin: the runtime's
status, start and stop; the model catalogue with install, remove, reveal and
resource usage; generation and the gloss; speech; the route probe; cloud
endpoint registration with a write-only key; one tool-free agent turn; and
cancellation for any streaming request.

NO GENERAL RUNNER IS AMONG THEM. No command takes a URL, a path, a host or an
argv: a caller names a model id that must resolve in models.manifest.json, or
a route id the probe minted. The bearer token, the loopback port and the cloud
API keys never cross to the webview, and there is deliberately no command that
reads a stored key back.

#### This default permission set includes the following:

- `allow-inference-status`
- `allow-inference-start`
- `allow-inference-stop`
- `allow-inference-models`
- `allow-inference-install-model`
- `allow-inference-remove-model`
- `allow-inference-resource-usage`
- `allow-inference-reveal-models-dir`
- `allow-inference-generate`
- `allow-inference-gloss`
- `allow-inference-speak`
- `allow-inference-probe`
- `allow-inference-endpoints`
- `allow-inference-add-endpoint`
- `allow-inference-remove-endpoint`
- `allow-inference-set-endpoint-key`
- `allow-agent-ask`
- `allow-agent-sign-in`
- `allow-inference-cancel`

## Permission Table

<table>
<tr>
<th>Identifier</th>
<th>Description</th>
</tr>


<tr>
<td>

`inference:allow-agent-ask`

</td>
<td>

Enables the agent_ask command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`inference:deny-agent-ask`

</td>
<td>

Denies the agent_ask command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`inference:allow-agent-sign-in`

</td>
<td>

Enables the agent_sign_in command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`inference:deny-agent-sign-in`

</td>
<td>

Denies the agent_sign_in command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`inference:allow-inference-add-endpoint`

</td>
<td>

Enables the inference_add_endpoint command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`inference:deny-inference-add-endpoint`

</td>
<td>

Denies the inference_add_endpoint command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`inference:allow-inference-cancel`

</td>
<td>

Enables the inference_cancel command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`inference:deny-inference-cancel`

</td>
<td>

Denies the inference_cancel command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`inference:allow-inference-endpoints`

</td>
<td>

Enables the inference_endpoints command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`inference:deny-inference-endpoints`

</td>
<td>

Denies the inference_endpoints command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`inference:allow-inference-generate`

</td>
<td>

Enables the inference_generate command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`inference:deny-inference-generate`

</td>
<td>

Denies the inference_generate command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`inference:allow-inference-gloss`

</td>
<td>

Enables the inference_gloss command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`inference:deny-inference-gloss`

</td>
<td>

Denies the inference_gloss command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`inference:allow-inference-install-model`

</td>
<td>

Enables the inference_install_model command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`inference:deny-inference-install-model`

</td>
<td>

Denies the inference_install_model command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`inference:allow-inference-models`

</td>
<td>

Enables the inference_models command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`inference:deny-inference-models`

</td>
<td>

Denies the inference_models command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`inference:allow-inference-probe`

</td>
<td>

Enables the inference_probe command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`inference:deny-inference-probe`

</td>
<td>

Denies the inference_probe command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`inference:allow-inference-remove-endpoint`

</td>
<td>

Enables the inference_remove_endpoint command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`inference:deny-inference-remove-endpoint`

</td>
<td>

Denies the inference_remove_endpoint command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`inference:allow-inference-remove-model`

</td>
<td>

Enables the inference_remove_model command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`inference:deny-inference-remove-model`

</td>
<td>

Denies the inference_remove_model command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`inference:allow-inference-resource-usage`

</td>
<td>

Enables the inference_resource_usage command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`inference:deny-inference-resource-usage`

</td>
<td>

Denies the inference_resource_usage command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`inference:allow-inference-reveal-models-dir`

</td>
<td>

Enables the inference_reveal_models_dir command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`inference:deny-inference-reveal-models-dir`

</td>
<td>

Denies the inference_reveal_models_dir command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`inference:allow-inference-set-endpoint-key`

</td>
<td>

Enables the inference_set_endpoint_key command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`inference:deny-inference-set-endpoint-key`

</td>
<td>

Denies the inference_set_endpoint_key command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`inference:allow-inference-speak`

</td>
<td>

Enables the inference_speak command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`inference:deny-inference-speak`

</td>
<td>

Denies the inference_speak command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`inference:allow-inference-start`

</td>
<td>

Enables the inference_start command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`inference:deny-inference-start`

</td>
<td>

Denies the inference_start command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`inference:allow-inference-status`

</td>
<td>

Enables the inference_status command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`inference:deny-inference-status`

</td>
<td>

Denies the inference_status command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`inference:allow-inference-stop`

</td>
<td>

Enables the inference_stop command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`inference:deny-inference-stop`

</td>
<td>

Denies the inference_stop command without any pre-configured scope.

</td>
</tr>
</table>

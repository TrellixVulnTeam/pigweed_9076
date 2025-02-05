// Copyright 2022 The Pigweed Authors
//
// Licensed under the Apache License, Version 2.0 (the "License"); you may not
// use this file except in compliance with the License. You may obtain a copy of
// the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
// WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
// License for the specific language governing permissions and limitations under
// the License.
#pragma once

#include "pw_rpc/internal/method_info.h"

namespace pw::rpc {

// Collection of various helpers for RPC calls introspection. For now contains
// only MethodRequestType/MethodResponseTypes types to obtain information about
// RPC methods request/response types.
//
// Example. We have an RPC service:
//
//   package some.package;
//   service SpecialService {
//     rpc MyMethod(MyMethodRequest) returns (MyMethodResponse) {}
//   }
//
// We also have a templated Storage type alias:
//
//   template <auto kMethod>
//   using Storage =
//      std::pair<MethodRequestType<kMethod>, MethodResponseType<kMethod>>;
//
// Storage<some::package::pw_rpc::pwpb::SpecialService::MyMethod> will
// instantiate as:
//
//   std::pair<some::package::MyMethodRequest::Message,
//             some::package::MyMethodResponse::Message>;

// Request type for given kMethod.
template <auto kMethod>
using MethodRequestType = typename internal::MethodInfo<kMethod>::Request;

// Response type for given kMethod.
template <auto kMethod>
using MethodResponseType = typename internal::MethodInfo<kMethod>::Response;

// Function which returns a serializer for given kMethod.
// For e.g. `pwpb` methods, this returns a `const PwpbMethodSerde&`.
template <auto kMethod>
using MethodSerde = typename internal::MethodInfo<kMethod>::serde;

}  // namespace pw::rpc
